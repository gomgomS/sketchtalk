import sys

sys.path.append("slapz102_core")
sys.path.append("slapz102_modules")
sys.path.append("slapz102_settings")
sys.path.append("slapz102_stdlib")
sys.path.append("slapz102_storage")

import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request

from pymongo import ReturnDocument

from slapz102_core import config
from slapz102_core import database
from slapz102_stdlib import sanitize

# ---------------------------------------------------------------------------
# SKETCHTALK MODULE — business logic layer.
#
# The proc hosts the "Visual Director": it turns a chunk of presentation
# transcript plus the current canvas state into a strict JSON directive
# (action / layout / objects) that the browser renders as minimalist
# line art.
#
# Two engines, tried in order:
#   1. Claude (Anthropic Messages API) when G_ANTHROPIC_API_KEY is set
#      and the `anthropic` package is installed.
#   2. A deterministic offline keyword parser (demo mode) so the app is
#      fully usable without an API key.
#
# No database collection is used by this feature; scene state lives in
# the browser and every request carries its own canvas context.
# ---------------------------------------------------------------------------

MAX_OBJECTS = 4

VALID_ACTIONS = ["IGNORE", "PAUSE", "RESUME", "UPDATE", "CLEAR_AND_DRAW"]
VALID_LAYOUTS = ["single", "flow", "hub_spoke", "comparison"]
VALID_BEATS = ["scene", "poster", "stat", "duo"]

# Voice commands handled deterministically before any engine runs.
PAUSE_WORDS = ["berhenti", "berhenti dulu", "stop", "pause", "tahan dulu"]
RESUME_WORDS = ["lanjutkan", "lanjut", "go on", "continue", "resume", "ok lanjut"]
CLEAR_PHRASES = [
    "hapus layar", "bersihkan layar", "slide baru", "halaman baru",
    "mulai dari awal", "clear screen", "new slide", "reset canvas"
]

# Old Lucide names the model may emit -> bundled file names.
ICON_ALIASES = {
    "alert-triangle": "triangle-alert",
    "alert-circle": "circle-alert",
    "check-circle": "circle-check",
    "x-circle": "circle-x",
    "bar-chart": "chart-column",
    "bar-chart-3": "chart-column",
    "bar-chart-2": "chart-column",
    "pie-chart": "chart-pie",
    "line-chart": "chart-line",
    "home": "house",
    "scales": "scale",
    "pencil": "pen-tool",
    "note": "sticky-note"
}

# The Visual Director system prompt (see the product spec) plus the
# runtime addendum: available icons and canvas-context contract.
SYSTEM_PROMPT_BASE = """# ROLE & OBJECTIVE
Kamu adalah "Visual Director" untuk aplikasi presentasi real-time berbasis suara bernama SketchTalk. Tugasmu mendengarkan transkrip ucapan pembicara secara bertahap dan mengubah inti gagasan menjadi instruksi visual bergaya Minimalist Black-and-White Line Art (garis vektor bersih dan presisi ala Lucide/Feather Icons di atas latar putih polos).

Prinsip utamamu adalah Kejelasan, Minimalisme, dan Kecermatan Konteks. Layar presentasi tidak boleh penuh sesak.

---

# STATE & VOICE COMMANDS (KONTROL SUARA)
Perhatikan status sistem (is_paused) dan kata kunci perintah dalam transkrip:
1. Perintah Jeda ("BERHENTI"): Jika pembicara mengucapkan kata kunci "BERHENTI", segera ubah status menjadi jeda ("action": "PAUSE"). Selama status jeda aktif, ABAIKAN semua ucapan berikutnya dan keluarkan "action": "IGNORE" hingga perintah lanjut diucapkan.
2. Perintah Lanjut ("LANJUTKAN"): Jika pembicara mengucapkan kata kunci "LANJUTKAN", aktifkan kembali sistem ("action": "RESUME") dan mulai proses ucapan setelahnya.
3. Anti-Noise (SANGAT TERBATAS): IGNORE HANYA untuk interjeksi/sapaan super pendek tanpa isi, maksimal 2 kata (contoh: "oke", "ya", "emm", "halo", "terima kasih"). SEMUA ucapan lain WAJIB tampil di layar. Jika tidak ada benda konkret yang bisa digambar, jangan tempel sticky-note — jadikan beat "poster" dengan headline yang kamu tulis sendiri. Contoh: "Oke gua mau tahu" -> beat poster, kicker "Rasa ingin tahu", headline "Mau tahu lebih dalam", objects kosong.

---

# LOGIKA KANVAS (CLEAR vs IMPROVE)
Kamu akan menerima konteks elemen yang sedang tampil di layar saat ini (current_canvas_objects, maksimal 4 objek). Evaluasi setiap kalimat baru dengan aturan berikut:

1. APPEND / IMPROVE (Tambah/Perkaya Layar Saat Ini):
   - Gunakan "action": "UPDATE" jika ucapan masih membahas topik yang sama, merupakan kelanjutan proses, cabang ide, atau perbandingan dari objek yang sudah ada di layar.
   - Batas Maksimal: Total objek di layar TIDAK BOLEH melebihi 4 objek.
   - Kamu boleh memperbarui label atau menambahkan angka penting pada objek yang sudah ada jika pembicara memberikan detail baru.

2. CLEAR & NEW TOPIC (Bersihkan & Mulai Baru):
   - Gunakan "action": "CLEAR_AND_DRAW" jika:
     a. Pembicara berpindah ke topik/bab baru yang tidak berkaitan langsung dengan visual di layar.
     b. Layar sudah berisi 4 objek dan pembicara menambahkan poin baru.
     c. Pembicara mengucapkan transisi eksplisit (misal: "Selanjutnya", "Poin berikutnya", "Beralih ke...").

---

# ATURAN DESAIN — PILIH FORMAT DULU, BARU ISI
Kamu adalah direktur presentasi, bukan penempel ikon. Setiap ucapan memilih SATU beat. Jangan memakai scene untuk semua kalimat.

- poster: layar ini HANYA tipografi. Untuk tesis, peringatan, kalimat emosional, atau gagasan yang lebih kuat sebagai kata daripada sebagai ikon. objects HARUS array kosong. layout "single".
- stat: angkanya adalah beritanya. hero_stat sangat besar, headline menjelaskan artinya dalam satu baris. Maksimal 1 objek, dan ikon itu hanya tanda kecil, bukan isi slide. layout "single".
- duo: satu kalimat tajam di kiri dan SATU gambar yang membuktikannya di kanan. Tepat 1 objek. layout "comparison".
- scene: cerita dengan benda yang bisa ditunjuk (perjalanan, orang, tempat, langkah). 1 sampai 4 objek. layout single / flow / hub_spoke / comparison seperti biasa.

Aturan ganti format: baca CURRENT_SLIDE. Jangan mengulang beat yang sama tiga kali berturut-turut. Setelah scene, klaim berikutnya lebih baik poster atau stat. Setelah poster, cerita konkret berikutnya harus scene.

Copywriting (ini yang membuat slide terasa ditulis, bukan disalin):
- headline BUKAN kutipan transkrip. Tulis baris yang seorang desainer taruh di layar: 3 sampai 8 kata, spesifik, aktif, bahasa penutur.
- kicker: 1-2 kata kategori, contoh "Masalah", "Angka", "Sekarang", "Nanti", "Kontras", "Perjalanan".
- hero_stat: hanya untuk beat stat. Angka ringkas ("60%", "3x", "5M"). Selain beat stat, isi null.
- label objek tetap pendek (1-3 kata). Jangan mengulang headline di label.

Layout scene (hanya jika beat = scene):
- single: 1 benda.
- flow: urutan cerita. Objek pertama = awal, objek terakhir = tujuan.
- hub_spoke: objek pertama = ide utama, sisanya cabang.
- comparison: objek awal = sisi kiri, objek akhir = sisi kanan.

Aturan ikon (hanya jika beat memakai objek):
- Nama ikon HANYA dari daftar IKON TERSEDIA. Pilih yang paling konkret.
- connect_to dan edge_label SELALU null.

Contoh keputusan:
- "Masalah utama kita biaya operasional yang membengkak" -> poster. kicker "Masalah". headline "Biaya operasional membengkak". objects [].
- "Kita pangkas biaya sampai 60 persen" -> stat. hero_stat "60%". kicker "Penghematan". headline "Biaya terpangkas". objects [] atau satu ikon.
- "Kemarin gua ke German" -> scene, layout flow, airplane + flag-germany. headline boleh kosong.
- "Bukan tambah orang, tapi rapikan sistem" -> duo. headline "Sistem, bukan kepala". satu ikon cpu.

---

# OUTPUT FORMAT (STRICT JSON)
Selalu balas HANYA dengan JSON valid tanpa teks pengantar atau markdown.

Schema:
{
  "action": "IGNORE | PAUSE | RESUME | UPDATE | CLEAR_AND_DRAW",
  "topic_summary": "Ringkasan 2-3 kata topik",
  "time_context": "past | present | future | none",
  "beat": "poster | stat | duo | scene",
  "kicker": "1-2 kata atau string kosong",
  "headline": "Baris slide yang kamu tulis, atau string kosong untuk scene",
  "hero_stat": "Angka ringkas atau null",
  "layout": "single | flow | hub_spoke | comparison",
  "objects": [
    {
      "id": "obj_1",
      "icon": "nama-ikon",
      "label": "Maksimal 3 Kata",
      "highlight_stat": "Angka ringkas atau null",
      "role": "subject | vehicle | destination | place | object | symbol"
    }
  ]
}
Jangan tulis connect_to atau edge_label.

Contoh poster — "Masalah utama kita biaya operasional membengkak":
{"action":"CLEAR_AND_DRAW","topic_summary":"Biaya Membengkak","time_context":"present","beat":"poster","kicker":"Masalah","headline":"Biaya operasional membengkak","hero_stat":null,"layout":"single","objects":[]}

Contoh stat — "kita pangkas biaya 60 persen":
{"action":"CLEAR_AND_DRAW","topic_summary":"Pangkas Biaya","time_context":"present","beat":"stat","kicker":"Penghematan","headline":"Biaya terpangkas","hero_stat":"60%","layout":"single","objects":[]}

Contoh scene — "Yesterday I went to Germany":
{"action":"CLEAR_AND_DRAW","topic_summary":"Perjalanan ke Jerman","time_context":"past","beat":"scene","kicker":"Perjalanan","headline":"","hero_stat":null,"layout":"flow","objects":[{"id":"obj_1","icon":"airplane","label":"Perjalanan","highlight_stat":null,"role":"vehicle"},{"id":"obj_2","icon":"flag-germany","label":"Jerman","highlight_stat":null,"role":"destination"}]}

---

# KONTEKS RUNTIME
- Pesan user berisi: STATUS, CURRENT_SLIDE (beat yang sedang tampil), CURRENT_CANVAS_OBJECTS, dan TRANSCRIPT.
- Saat UPDATE, pertahankan id objek lama yang masih relevan agar transisi di layar mulus; tambahkan objek baru dengan id baru (obj_5, obj_6, ...).
- label, topic_summary, dan edge_label HARUS mengikuti bahasa transkrip (Bahasa Indonesia untuk id-ID, English untuk en-US).
- Jika transkrip murni basa-basi tanpa gagasan, keluarkan IGNORE dengan objects kosong.

---

# GAYA VISUAL: PIKTOGRAM CERITA (PRIORITAS UNTUK CERITA PRIBADI)
Jika ucapan bercerita (pengalaman, perjalanan, masa lalu, rencana), pilih ikon PIKTOGRAM KONKRET yang menggambarkan objeknya, BUKAN ikon bisnis abstrak. Pola contoh (training):
- "Kemarin gua ke German" -> airplane + flag-germany (flow).
- "Kemarin gua naik kereta ke Bandung" -> train + map-pin "Bandung" (flow).
- "Waktu gua masih sekolah" -> school-kid "Anak Sekolah" (single).
- "Jadi waktu gua masih bocah magang" -> graduation-cap "Bocah Magang".
- "Dulu gua tinggal di desa" -> village "Desa".
- "Minggu lalu gua pergi ke rumah sakit" -> user + hospital (flow).
- "Waktu kecil gua suka main bola" -> football.
- "Tahun depan gua mau kuliah di Jerman" -> graduation-cap + flag-germany (flow).
Bendera tersedia: flag-germany, flag-japan, flag-indonesia. Untuk kota/tempat lain gunakan map-pin dengan label nama tempat. Perjalanan ke negara/kota jauh ("ke German", "ke Jepang", "Ke Bandung") SELALU digambarkan sebagai dua kartu berdampingan: vehicle (airplane untuk luar kota, train jika kereta disebut) dan kartu tempat, meski kata kendaraan tidak diucapkan. Orang pertama ("gua/saya") yang JALAN kaki ke tempat dekat (mis. "pergi ke rumah sakit") digambarkan sebagai user.

---

# SAPAAN SINGKAT (SATU IKON, LAYOUT single)
Jika ucapan HANYA sapaan, tanpa gagasan lain, gambar satu simbol yang langsung terbaca. Jangan IGNORE.
- "Selamat pagi" / "good morning" -> sunrise, label "Pagi" atau "Morning".
- "Selamat siang" / "good afternoon" -> sun, label "Siang" atau "Afternoon".
- "Selamat sore" -> sunset, label "Sore".
- "Selamat malam" / "good evening" / "good night" -> moon (bulan sabit), label "Malam" / "Evening" / "Night".
- "Selamat Hari Sabat" / "happy sabbath" -> sabbath, label "Hari Sabat" atau "Sabbath".
- "Selamat datang" / "welcome" -> welcome.
- "Selamat ulang tahun" / "happy birthday" -> cake.
Jika sapaan diikuti gagasan nyata (masalah, angka, rencana), gambar gagasan itu, bukan hanya sapaannya.

---

# METODE ADEGAN VISUAL — SATU KALIMAT = SATU ADEGAN BERMAKNA
Berpikir bertahap di dalam penalaran (tidak ditulis ke output): (1) ANALISIS SEMANTIK: subject/action/object/location/time_context dari kalimat UTUH, bukan per kata. (2) RENCANAKAN adegan paling sederhana yang mengkomunikasikan makna lengkap — hanya elemen informatif, tanpa dekorasi. (3) PILIH ikon terdekat secara SEMANTIK dari IKON TERSEDIA; jangan mengarang nama; arah/urutan cukup lewat posisi & layout. (4) KOMPOSISI via layout + role. (5) GAYA minimalis hitam-putih. (6) VALIDASI: ikon tersedia di library? hubungan jelas? adegan dipahami tanpa membaca kalimatnya?

---

# TRANSKRIP PARSIAL (MODE REAL-TIME)
Jika TRANSCRIPT ditandai "(PARSIAL)", pembicara MASIH bicara dan kalimat bisa terpotong — jangan tunggu kalimat lengkap. Segera keluarkan directive terbaik dari gagasan yang sudah terdengar (biasanya UPDATE untuk memperkaya layar). Directive ini bersifat sementara dan akan segera digantikan oleh transkrip berikutnya, jadi boleh lebih sederhana dan cepat.
"""

# ---------------------------------------------------------------------------
# Icon inventory — the hand-authored set drawn in
# static/sketchtalk/sketchtalk-icons.js (ICON LIBRARY). Keep these names
# in sync with the JS library keys.
# ---------------------------------------------------------------------------

ICON_FALLBACK_LIST = [
    "airplane", "book-open", "brain", "briefcase", "bug", "building-2",
    "calendar", "chart-column", "check", "circle-check", "circle-x",
    "clock", "cloud", "coins", "cpu", "database", "dollar-sign",
    "download", "eye", "flag", "flag-germany", "flag-indonesia",
    "flag-japan", "football", "globe", "graduation-cap", "handshake",
    "heart", "hospital", "house", "hourglass", "layers", "lightbulb",
    "link", "list-checks", "lock", "mail", "map-pin", "megaphone",
    "message-circle", "office-desk", "package", "presentation", "rocket",
    "route", "school-kid", "search", "server", "settings", "shield",
    "shield-check", "soccer-kick", "sparkles", "star", "sticky-note",
    "target", "train", "triangle-alert", "trending-down", "trending-up",
    "trophy", "user", "users", "village", "wallet", "worker", "workflow",
    "zap"
]

# The whitelist is derived automatically from the icon library file, so
# drawing a new icon in sketchtalk-icons.js makes it instantly available
# to the model and the validator (mtime-cached, refreshed on edit).
_ICONS_JS_CACHE = {"mtime": None, "names": []}

def available_icons():
    icons_js = os.path.join(config.G_HOME_PATH, "static", "sketchtalk", "sketchtalk-icons.js")
    try:
        mtime = os.path.getmtime(icons_js)
    except OSError:
        mtime = None
    # end try
    if _ICONS_JS_CACHE["mtime"] == mtime and len(_ICONS_JS_CACHE["names"]) > 0:
        return _ICONS_JS_CACHE["names"]
    # end if
    names = []
    try:
        with open(icons_js, "r", encoding="utf-8") as f:
            content = f.read()
        # end with
        names = sorted(set(re.findall(r"^\s*'([a-z0-9-]+)':\s*\[", content, re.MULTILINE)))
    except Exception as e:
        print("[SketchTalk] could not read icon library: " + str(e), flush=True)
    # end try
    if len(names) == 0:
        names = list(ICON_FALLBACK_LIST)
    # end if
    _ICONS_JS_CACHE["mtime"] = mtime
    _ICONS_JS_CACHE["names"] = names
    return names
# end def

_ICON_CACHE = {"prompt_text": "", "key": ""}

def _icon_prompt_text():
    names = available_icons()
    key = str(len(names)) + ":" + names[0] + names[len(names) - 1]
    if _ICON_CACHE["prompt_text"] != "" and _ICON_CACHE.get("key") == key:
        return _ICON_CACHE["prompt_text"]
    # end if
    text = "\n# IKON TERSEDIA\nGunakan HANYA nama ikon dari daftar ini:\n" + ", ".join(names) + "\n"
    _ICON_CACHE["key"] = key
    _ICON_CACHE["prompt_text"] = text
    return text
# end def

# ---------------------------------------------------------------------------
# JSON schema enforced by the Messages API structured output.
# ---------------------------------------------------------------------------

DIRECTIVE_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": VALID_ACTIONS},
        "topic_summary": {"type": "string"},
        "time_context": {"type": "string", "enum": ["past", "present", "future", "none"]},
        "layout": {"type": "string", "enum": VALID_LAYOUTS},
        "beat": {"type": "string", "enum": VALID_BEATS},
        "kicker": {"type": "string"},
        "headline": {"type": "string"},
        "hero_stat": {"type": ["string", "null"]},
        "objects": {
            "type": "array",
            "maxItems": MAX_OBJECTS,
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "icon": {"type": "string"},
                    "label": {"type": "string"},
                    "highlight_stat": {"type": ["string", "null"]},
                    "connect_to": {"type": ["string", "null"]},
                    "edge_label": {"type": ["string", "null"]},
                    "role": {"type": "string", "enum": ["subject", "vehicle", "destination", "place", "object", "symbol"]}
                },
                "required": ["id", "icon", "label", "highlight_stat", "connect_to", "edge_label", "role"],
                "additionalProperties": False
            }
        },
    },
    "required": ["action", "topic_summary", "time_context", "layout", "beat", "kicker", "headline", "hero_stat", "objects"],
    "additionalProperties": False
}

# ---------------------------------------------------------------------------
# Claude client (lazy, module-level cache — one client per process).
# ---------------------------------------------------------------------------

_AI_STATE = {"client": None, "tried": False}

def _get_client():
    if _AI_STATE["tried"]:
        return _AI_STATE["client"]
    # end if
    _AI_STATE["tried"] = True
    try:
        import anthropic
    except ImportError:
        _AI_STATE["client"] = None
        return None
    # end try
    try:
        api_key = config.G_ANTHROPIC_API_KEY
        if api_key != "":
            _AI_STATE["client"] = anthropic.Anthropic(
                api_key=api_key, timeout=25.0, max_retries=1
            )
        else:
            # No explicit key: let the SDK resolve env credentials.
            _AI_STATE["client"] = anthropic.Anthropic(timeout=25.0, max_retries=1)
        # end if
    except Exception:
        _AI_STATE["client"] = None
    # end try
    return _AI_STATE["client"]
# end def

def _contains_any(lower_text, phrases):
    for phrase in phrases:
        if re.search(r"\b" + re.escape(phrase) + r"\b", lower_text) != None:
            return True
        # end if
    # end for
    return False
# end def

# ---------------------------------------------------------------------------
# Offline keyword concepts (demo mode / API unavailable).
# Order matters only for keyword search, icons render in speech order.
# ---------------------------------------------------------------------------

CONCEPTS = [
    ("lightbulb", ["ide", "gagasan", "inovasi", "kreatif", "solusi", "konsep", "idea", "innovation", "creative", "solution"]),
    ("users", ["tim", "orang", "pengguna", "klien", "pelanggan", "manusia", "team", "people", "user", "customer", "client"]),
    ("trending-up", ["naik", "tumbuh", "meningkat", "pertumbuhan", "grafik", "statistik", "performa", "tren", "growth", "increase", "rise", "trend"]),
    ("trending-down", ["turun", "menurun", "merosot", "decline", "decrease", "drop"]),
    ("chart-column", ["data", "laporan", "metrik", "angka", "chart", "report", "analytics"]),
    ("dollar-sign", ["uang", "profit", "untung", "biaya", "modal", "investasi", "harga", "pendapatan", "revenue", "money", "cost", "budget", "dollar"]),
    ("server", ["server", "sistem", "aplikasi", "platform", "teknologi", "mesin", "web", "system", "app", "tech", "software"]),
    ("database", ["database", "informasi", "arsip", "dokumen", "catatan", "file", "storage", "record"]),
    ("target", ["target", "tujuan", "fokus", "sukses", "visi", "misi", "goal", "aim", "success", "vision"]),
    ("triangle-alert", ["masalah", "risiko", "kendala", "hambatan", "error", "bahaya", "tantangan", "sulit", "problem", "issue", "risk", "warning", "challenge"]),
    ("bug", ["bug", "cacat", "kerusakan", "defect"]),
    ("clock", ["jadwal", "deadline", "durasi", "jam", "time", "schedule", "timeline", "clock"]),
    ("calendar", ["tanggal", "kalender", "kuartal", "quarter", "calendar", "monthly"]),
    ("globe", ["global", "dunia", "pasar", "market", "publik", "internet", "jaringan", "world", "network", "international"]),
    ("shield-check", ["aman", "keamanan", "privasi", "lindungi", "proteksi", "security", "safe", "privacy", "protect"]),
    ("circle-check", ["selesai", "setuju", "benar", "berhasil", "valid", "done", "agree", "complete", "verified"]),
    ("rocket", ["peluncuran", "meluncur", "mulai", "start", "launch", "kickoff"]),
    ("brain", ["pikir", "belajar", "analisis", "analisa", "kecerdasan", "ai", "learning", "analysis", "intelligence"]),
    ("zap", ["energi", "efisien", "produktivitas", "energy", "efficient", "productivity"]),
    ("workflow", ["proses", "alur", "langkah", "tahap", "workflow", "process", "step"]),
    ("layers", ["lapisan", "modul", "struktur", "versi", "layers", "module", "structure"]),
    ("cpu", ["otomasi", "otomatis", "cpu", "automation", "automated", "compute"]),
    ("building-2", ["perusahaan", "kantor pusat", "bisnis", "organisasi", "company", "business", "organization"]),
    ("airplane", ["pesawat", "terbang", "penerbangan", "berangkat", "takeoff", "flight", "airplane", "plane"]),
    ("train", ["kereta", "stasiun", "train", "railway"]),
    ("graduation-cap", ["kuliah", "universitas", "wisuda", "sarjana", "magang", "kampus", "internship", "graduate"]),
    ("school-kid", ["sekolah", "pelajar", "siswa", "murid", "school", "student"]),
    ("worker", ["kerja", "karyawan", "pekerja", "bekerja", "employee"]),
    ("village", ["desa", "kampung", "village"]),
    ("hospital", ["rumah sakit", "dokter", "opname", "sakit", "hospital", "clinic", "klinik"]),
    ("football", ["bola", "sepak", "football", "soccer"]),
    ("office-desk", ["kantor", "office"]),
    ("megaphone", ["marketing", "promosi", "kampanye", "iklan", "pengumuman", "campaign", "announcement"]),
    ("handshake", ["kemitraan", "kerja sama", "kolaborasi", "partner", "partnership", "collaboration"]),
    ("package", ["produk", "barang", "product", "package", "goods"]),
    ("presentation", ["presentasi", "slide", "presentation", "deck"]),
    ("star", ["bintang", "unggul", "premium", "star", "excellent"]),
    ("trophy", ["juara", "menang", "prestasi", "achievement", "win", "champion"]),
    ("lock", ["kunci", "akses", "terkunci", "lock", "access"]),
    ("cloud", ["cloud", "awan", "hosting", "server pusat"]),
    ("route", ["jalur", "arah", "rencana", "route", "path", "plan"]),
    ("list-checks", ["checklist", "daftar", "list", "todo"]),
    ("sparkles", ["magis", "ajaib", "fitur baru", "magic", "sparkle"]),
    ("hourglass", ["tunggu", "antre", "delay", "wait", "queue"]),
    ("wallet", ["dompet", "belanja", "anggaran", "wallet", "spending"]),
    ("search", ["mau tahu", "ingin tahu", "penasaran", "bertanya", "tanya", "cari", "carikan", "mencari", "curious", "wonder", "find", "search"])
]

NOISE_WORDS = [
    "halo", "hallo", "hai", "hi", "hello", "selamat", "pagi", "siang", "sore",
    "malam", "terima", "kasih", "thank", "you", "oke", "okay", "ok", "ya",
    "nah", "jadi", "gini", "begini", "eee", "umm", "ehm", "apa",
    "kabar", "assalamualaikum", "permisi", "well", "let", "us", "the",
    "and", "dan", "yang", "ini", "itu", "dengan", "untuk", "dari", "para",
    "semuanya", "everyone", "guys", "teamnya", "kita", "kami", "saya",
    "akan", "mau", "bisa", "adalah", "perlu", "harus",
    "teman", "hari", "mulai", "presentasi", "rapat", "meeting", "acara",
    "sebentar", "dulu", "mungkin", "sebenarnya", "sesungguhnya", "mari",
    "ayo", "yuk", "silakan", "mohon", "maaf", "perkenalkan", "langsung",
    "coba", "lihat", "dengar", "perhatikan", "semua", "bapak", "ibu",
    "langsung", "saja", "banget", "kalau", "jika", "karena", "bahwa"
]

TRANSITION_WORDS = [
    "selanjutnya", "berikutnya", "poin berikutnya", "topik berikutnya",
    "beralih", "pindah ke", "bagian berikutnya", "next", "moving on",
    "second topic", "lalu topik"
]

CONTRAST_WORDS = [
    "tapi", "namun", "sedangkan", "dibanding", "sementara", "versus", "vs",
    "but", "however", "whereas", "instead", "sehingga bisa"
]

FLOW_WORDS = [
    "karena", "sehingga", "maka", "lalu", "kemudian", "setelah", "menuju",
    "menyebabkan", "menghasilkan", "because", "then", "leads", "produces"
]

HUB_WORDS = [
    "terdiri", "terhubung", "pusat", "komponen", "bagian", "unsur",
    "consists", "connected", "center", "components"
]

TRAVEL_ICONS = ["airplane", "train"]

ROLE_BY_ICON = {
    "user": "subject", "users": "subject", "school-kid": "subject", "worker": "subject",
    "airplane": "vehicle", "train": "vehicle",
    "flag-germany": "destination", "flag-japan": "destination",
    "flag-indonesia": "destination", "map-pin": "destination",
    "hospital": "place", "village": "place", "office-desk": "place",
    "house": "place", "building-2": "place"
}

TIME_MARKERS = [
    ("past", ["kemarin", "dulu", "dahulu", "lalu", "waktu kecil", "waktu gua", "waktu saya", "masih bocah", "baru saja", "sudah"]),
    ("future", ["besok", "nanti", "akan", "rencana", "ingin", "hendak", "depan"]),
    ("present", ["sekarang", "lagi", "sedang", "saat ini"])
]

def _role_for_icon(icon):
    return ROLE_BY_ICON.get(icon, "object")
# end def

def _detect_time(lower):
    for label, markers in TIME_MARKERS:
        if _contains_any(lower, markers):
            return label
        # end if
    # end for
    return "none"
# end def

PLACE_FLAGS = {
    "jerman": "flag-germany", "german": "flag-germany", "germany": "flag-germany",
    "jepang": "flag-japan", "japan": "flag-japan", "nippon": "flag-japan",
    "indonesia": "flag-indonesia"
}

PLACE_STOP = [
    "rumah", "sakit", "sekolah", "kantor", "kampus", "universitas", "desa",
    "kampung", "target", "atas", "bawah", "sana", "sini", "mana", "sana",
    "lokasi", "tempat", "kerja", "kuliah", "seberang", "belakang", "depan"
]

STAT_PATTERNS = [
    (re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:%|persen|percent)"), lambda m: m.group(1).replace(",", ".") + "%"),
    (re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:x|kali|lipat)\b"), lambda m: m.group(1).replace(",", ".") + "x"),
    (re.compile(r"rp\.?\s*([\d.,]+)\s*(triliun|t|miliar|m|juta|jt|ribu|rb)?", re.IGNORECASE), None),
    (re.compile(r"(\d+)\s*(langkah|poin|tahap|fitur|aplikasi|cabang|region|negara|orang|tim)\b"), None)
]

def _extract_stat(text):
    for pattern, formatter in STAT_PATTERNS:
        match = pattern.search(text)
        if match == None:
            continue
        # end if
        if formatter != None:
            return formatter(match)
        # end if
        if pattern.pattern.find("rp") >= 0:
            unit = (match.group(2) or "").lower()
            unit_map = {"triliun": "T", "t": "T", "miliar": "M", "m": "M", "juta": "Jt", "jt": "Jt", "ribu": "Rb", "rb": "Rb"}
            short = unit_map.get(unit, "")
            return "Rp " + match.group(1) + short
        # end if
        return match.group(1) + " " + match.group(2).capitalize()
    # end for
    return None
# end def

# Longest phrase first so "hari sabat" wins over "sabat".
# A pure greeting is the phrase plus filler words only.
GREETINGS = [
    ("selamat ulang tahun", "cake", "Ulang Tahun"),
    ("happy birthday", "cake", "Birthday"),
    ("selamat hari sabat", "sabbath", "Hari Sabat"),
    ("happy sabbath", "sabbath", "Sabbath"),
    ("good afternoon", "sun", "Afternoon"),
    ("good morning", "sunrise", "Morning"),
    ("good evening", "moon", "Evening"),
    ("selamat datang", "welcome", "Datang"),
    ("ulang tahun", "cake", "Ulang Tahun"),
    ("good night", "moon", "Night"),
    ("selamat pagi", "sunrise", "Pagi"),
    ("selamat siang", "sun", "Siang"),
    ("selamat sore", "sunset", "Sore"),
    ("selamat malam", "moon", "Malam"),
    ("hari sabat", "sabbath", "Hari Sabat"),
    ("sabbath", "sabbath", "Sabbath"),
    ("welcome", "welcome", "Welcome"),
    ("sabat", "sabbath", "Sabat")
]

def _match_greeting(text):
    lower = re.sub(r"[^a-z]+", " ", (text or "").lower()).strip()
    padded = " " + lower + " "
    for phrase, icon, label in GREETINGS:
        token = " " + phrase + " "
        if padded.find(token) < 0:
            continue
        # end if
        rest = padded.replace(token, " ", 1)
        extra = False
        for word in rest.split():
            if word not in NOISE_WORDS:
                extra = True
                break
            # end if
        # end for
        if not extra:
            return {"icon": icon, "label": label}
        # end if
    # end for
    return None
# end def

def _greeting_directive(greeting):
    label = greeting["label"]
    return {
        "action": "CLEAR_AND_DRAW",
        "topic_summary": label,
        "layout": "single",
        "objects": [{
            "id": "obj_1",
            "icon": greeting["icon"],
            "label": label,
            "highlight_stat": None,
            "connect_to": None,
            "edge_label": None,
            "role": "symbol"
        }],
        "time_context": "present",
        "scene_description": label + ".",
        "beat": "scene",
        "kicker": "",
        "headline": "",
        "hero_stat": None,
        "semantic_analysis": {
            "subject": "",
            "action": "Menyapa",
            "object": label,
            "location": ""
        }
    }
# end def

def _is_noise(text):
    # Policy: only ultra-short pure interjections are ignored (<= 2 words,
    # all filler). Everything the speaker says must become an illustration.
    words = re.findall(r"[a-z]+", text.lower())
    if len(words) == 0:
        return True
    # end if
    if len(words) > 2:
        return False
    # end if
    for word in words:
        if word not in NOISE_WORDS:
            return False
        # end if
    # end for
    return True
# end def

def _detect_concepts(text):
    lower = text.lower()
    detected = []
    for icon, keywords in CONCEPTS:
        best_index = -1
        best_word = ""
        for kw in keywords:
            match = re.search(r"\b" + re.escape(kw) + r"\b", lower)
            if match != None and (best_index == -1 or match.start() < best_index):
                best_index = match.start()
                best_word = match.group(0)
            # end if
        # end for
        if best_index >= 0:
            detected.append({"index": best_index, "icon": icon, "word": best_word})
        # end if
    # end for
    detected.sort(key=lambda item: item["index"])
    return detected
# end def

def _offline_beat(objects, stat, layout):
    # The offline path cannot write like a model, but it can still pick
    # a format so a number becomes a number and a note becomes type.
    pack = {"beat": "scene", "kicker": "", "headline": "", "hero_stat": None}
    if stat != None and len(objects) == 1:
        pack["beat"] = "stat"
        pack["kicker"] = "Angka"
        pack["headline"] = objects[0]["label"]
        pack["hero_stat"] = stat
        return pack
    # end if
    if len(objects) == 1 and objects[0].get("icon") == "sticky-note":
        pack["beat"] = "poster"
        pack["kicker"] = "Inti"
        pack["headline"] = objects[0]["label"]
        return pack
    # end if
    if layout == "comparison" and len(objects) >= 2:
        pack["beat"] = "duo"
        pack["kicker"] = "Kontras"
        pack["headline"] = objects[0]["label"] + " lawan " + objects[len(objects) - 1]["label"]
        return pack
    # end if
    return pack
# end def

def _fallback_director(transcript, canvas_objects):
    if _is_noise(transcript):
        return {"action": "IGNORE", "topic_summary": "", "layout": "single", "objects": []}
    # end if
    lower = transcript.lower()
    detected = _detect_concepts(transcript)

    # Destination detection for story sentences: a known country becomes a
    # flag node; a place after a travel verb becomes a map-pin node.
    detected_icons = [item["icon"] for item in detected]
    detected_words = [item["word"] for item in detected]
    has_travel = len([icon for icon in detected_icons if icon in TRAVEL_ICONS]) > 0
    place_match = re.search(r"\b(?:ke|di|menuju)\s+([A-Za-z]+)", transcript, re.IGNORECASE)
    if place_match != None:
        place_word = place_match.group(1).lower()
        is_flag = place_word in PLACE_FLAGS
        if is_flag or (has_travel and place_word not in PLACE_STOP and place_word not in detected_words and len(place_word) > 2):
            icon = PLACE_FLAGS.get(place_word, "map-pin")
            if icon not in detected_icons:
                if not has_travel and "user" not in detected_icons:
                    if is_flag:
                        # Going to a country always implies a flight.
                        detected.append({"index": 9997, "icon": "airplane", "word": "Perjalanan"})
                    elif _contains_any(lower, ["pergi", "jalan ke"]):
                        # Walking to a nearby place: the speaker is the node.
                        detected.append({"index": 9997, "icon": "user", "word": "Gua"})
                    # end if
                # end if
                detected.append({"index": 9998, "icon": icon, "word": place_match.group(1).title()})
            # end if
        # end if
    # end if

    # Working at an office is the desk scene, not two separate nodes.
    if "office-desk" in [item["icon"] for item in detected]:
        detected = [item for item in detected if item["icon"] != "worker"]
    # end if

    if len(detected) == 0:
        content_words = []
        for w in re.findall(r"[a-zA-Z]+", transcript):
            if w.lower() not in NOISE_WORDS:
                content_words.append(w)
            # end if
        # end for
        if len(content_words) == 0:
            content_words = transcript.split()[0:2]
        # end if
        label = " ".join(content_words[0:3]).title()
        print("[SketchTalk] fallback: no concrete icon -> note card '" + label + "'", flush=True)
        detected = [{"index": 0, "icon": "sticky-note", "word": label}]
    # end if

    detected = detected[0:MAX_OBJECTS]

    stat = _extract_stat(transcript)

    objects = []
    for pos, item in enumerate(detected):
        label = item["word"]
        label = label[0].upper() + label[1:]
        obj = {
            "id": "obj_" + str(pos + 1),
            "icon": item["icon"],
            "label": label,
            "highlight_stat": None,
            "connect_to": None,
            "edge_label": None
        }
        objects.append(obj)
    # end for

    topic_words = re.findall(r"[a-z]{4,}", lower)
    topic_summary = " ".join(topic_words[0:2]).title()

    existing_icons = []
    for obj in canvas_objects:
        existing_icons.append(str(obj.get("icon") or ""))
    # end for
    new_icons = [item["icon"] for item in detected]
    fresh_icons = [icon for icon in new_icons if icon not in existing_icons]
    is_transition = _contains_any(lower, TRANSITION_WORDS)
    has_contrast = _contains_any(lower, CONTRAST_WORDS)

    # Action (canvas logic from the spec):
    #  - empty canvas              -> CLEAR_AND_DRAW
    #  - explicit transition       -> CLEAR_AND_DRAW
    #  - full canvas + new concept -> CLEAR_AND_DRAW (max-4 rule)
    #  - otherwise                 -> UPDATE (merge)
    if len(canvas_objects) == 0:
        action = "CLEAR_AND_DRAW"
    elif is_transition:
        action = "CLEAR_AND_DRAW"
    elif len(canvas_objects) >= MAX_OBJECTS and len(fresh_icons) > 0:
        action = "CLEAR_AND_DRAW"
    else:
        action = "UPDATE"
    # end if

    if action == "UPDATE":
        merged = []
        used_icons = []
        next_id = 1
        for obj in canvas_objects:
            merged.append({
                "id": str(obj.get("id") or ("obj_" + str(next_id))),
                "icon": str(obj.get("icon") or "sticky-note"),
                "label": str(obj.get("label") or ""),
                "highlight_stat": obj.get("highlight_stat"),
                "connect_to": None,
                "edge_label": None
            })
            used_icons.append(merged[len(merged) - 1]["icon"])
            next_id = next_id + 1
        # end for
        added = []
        for obj in objects:
            if len(merged) >= MAX_OBJECTS:
                break
            # end if
            if obj["icon"] in used_icons:
                continue
            # end if
            obj["id"] = "obj_" + str(next_id)
            next_id = next_id + 1
            merged.append(obj)
            added.append(obj)
        # end for
        # A contrast sentence collapses into a clean two-sided comparison:
        # the established object on the left, the strongest new one right.
        if has_contrast and len(merged) >= 2 and len(added) > 0:
            keeper = added[0]
            if stat != None:
                keeper["highlight_stat"] = stat
                stat = None
            # end if
            merged = [merged[0], keeper]
        # end if
        objects = merged
    # end if

    if stat != None and len(objects) > 0:
        objects[len(objects) - 1]["highlight_stat"] = stat
    # end if

    count = len(objects)
    if count == 1:
        layout = "single"
    elif _contains_any(lower, HUB_WORDS):
        layout = "hub_spoke"
    elif count == 2 and has_contrast:
        layout = "comparison"
    elif _contains_any(lower, FLOW_WORDS):
        layout = "flow"
    else:
        layout = "flow"
    # end if

    # Arrows are retired: relationship is expressed by position/layout only.

    # Scene metadata (scene-engine fields, derived offline).
    for obj in objects:
        obj["role"] = _role_for_icon(obj.get("icon"))
    # end for
    subject = ""
    location = ""
    action_word = ""
    for obj in objects:
        if obj["role"] == "subject" and subject == "":
            subject = obj["label"]
        # end if
        if obj["role"] in ("destination", "place") and location == "":
            location = obj["label"]
        # end if
    # end for
    if subject == "" and _contains_any(lower, ["gua", "gue", "saya", "aku"]):
        subject = "Gua"
    # end if
    if len(detected) > 0:
        action_word = detected[0]["word"].capitalize()
    # end if
    beat_pack = _offline_beat(objects, stat, layout)

    return {
        "action": action,
        "topic_summary": topic_summary,
        "layout": layout,
        "objects": objects,
        "time_context": _detect_time(lower),
        "scene_description": (topic_summary + ".") if topic_summary != "" else "",
        "semantic_analysis": {
            "subject": subject,
            "action": action_word,
            "object": objects[0]["label"] if len(objects) > 0 else "",
            "location": location
        },
        "beat": beat_pack["beat"],
        "kicker": beat_pack["kicker"],
        "headline": beat_pack["headline"],
        "hero_stat": beat_pack["hero_stat"]
    }
# end def

# ---------------------------------------------------------------------------
# Directive validation — the single trust boundary for engine output.
# ---------------------------------------------------------------------------

VALID_TIME = ["past", "present", "future", "none"]
VALID_ROLES = ["subject", "vehicle", "destination", "place", "object", "symbol"]

def _clean_str(value, max_len):
    if value == None:
        return None
    # end if
    if not isinstance(value, str):
        value = str(value)
    # end if
    value = sanitize.clean_html(" ".join(value.split()))
    if value == "":
        return None
    # end if
    return value[0:max_len]
# end def

def _read_beat(raw, objects):
    beat = raw.get("beat")
    if beat not in VALID_BEATS:
        beat = "scene"
    # end if
    headline = _clean_str(raw.get("headline"), 72)
    if headline == None:
        headline = ""
    # end if
    kicker = _clean_str(raw.get("kicker"), 22)
    if kicker == None:
        kicker = ""
    # end if
    hero = _clean_str(raw.get("hero_stat"), 12)
    if beat == "poster" and headline == "" and len(objects) > 0:
        headline = objects[0]["label"]
    # end if
    if beat == "stat" and hero == None and len(objects) > 0:
        hero = objects[0].get("highlight_stat")
    # end if
    if beat == "duo" and headline == "" and len(objects) >= 2:
        headline = objects[0]["label"] + " lawan " + objects[len(objects) - 1]["label"]
    # end if
    if beat == "poster" and headline == "":
        beat = "scene"
    # end if
    if beat == "duo" and len(objects) == 0:
        if headline != "":
            beat = "poster"
        else:
            beat = "scene"
        # end if
    # end if
    if beat == "stat" and (hero == None or hero == ""):
        beat = "scene"
        hero = None
    # end if
    return {"beat": beat, "kicker": kicker, "headline": headline, "hero_stat": hero}
# end def

def _clean_semantic(raw):
    analysis = {"subject": "", "action": "", "object": "", "location": ""}
    if isinstance(raw, dict):
        for key in analysis:
            val = _clean_str(raw.get(key), 24)
            analysis[key] = val if val != None else ""
        # end for
    # end if
    return analysis
# end def

# ---------------------------------------------------------------------------
# Missing-icon tracker: icons the model asks for that do not exist in the
# library are reported to training-model-folder/missing-icons/ so they can
# be hand-drawn and added to sketchtalk-icons.js.
# ---------------------------------------------------------------------------

MISSING_ICONS_DIR = os.path.join(config.G_HOME_PATH, "training-model-folder", "missing-icons")
_MISSING_ICONS = {"missing": {}, "fuzzy": {}}

def _record_missing_icon(kind, requested, resolved, transcript):
    entry = _MISSING_ICONS[kind].get(requested)
    if entry == None:
        entry = {"count": 0, "resolved": resolved, "example": ""}
        _MISSING_ICONS[kind][requested] = entry
    # end if
    entry["count"] = entry["count"] + 1
    if transcript != "" and entry["example"] == "":
        entry["example"] = transcript[0:100]
    # end if
    if kind == "missing":
        print("[SketchTalk] MISSING ICON '" + requested + "' -> sticky-note | gambar di static/sketchtalk/sketchtalk-icons.js (laporan: training-model-folder/missing-icons/)", flush=True)
    # end if
    try:
        if os.path.isdir(MISSING_ICONS_DIR) == False:
            os.makedirs(MISSING_ICONS_DIR, exist_ok=True)
        # end if
        summary = {
            "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
            "missing": _MISSING_ICONS["missing"],
            "fuzzy": _MISSING_ICONS["fuzzy"],
            "how_to_fix": "tambahkan ikon baru di static/sketchtalk/sketchtalk-icons.js (nama = key), lalu reload. Whitelist server menyesuaikan otomatis."
        }
        with open(os.path.join(MISSING_ICONS_DIR, "missing-icons.json"), "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)
        # end with
        with open(os.path.join(MISSING_ICONS_DIR, "missing-icons.log"), "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S") + " " + kind + " '" + requested + "' -> " + resolved + (": " + transcript[0:80] if transcript != "" else "") + "\n")
        # end with
    except Exception as e:
        print("[SketchTalk] could not write missing-icons report: " + str(e), flush=True)
    # end try
# end def

def _resolve_icon(name, transcript):
    if not isinstance(name, str):
        return "sticky-note"
    # end if
    if not isinstance(name, str) or name.strip() == "":
        return "sticky-note"
    # end if
    name = name.strip().lower()
    if name in ICON_ALIASES:
        name = ICON_ALIASES[name]
    # end if
    names = available_icons()
    if name in names:
        return name
    # end if
    if len(name) >= 3:
        for candidate in names:
            if candidate.find(name) >= 0 or name.find(candidate) >= 0:
                _record_missing_icon("fuzzy", name, candidate, transcript)
                return candidate
            # end if
        # end for
    # end if
    _record_missing_icon("missing", name, "sticky-note", transcript)
    return "sticky-note"
# end def

def _validate_directive(raw, transcript=""):
    if not isinstance(raw, dict):
        return {"action": "IGNORE", "topic_summary": "", "layout": "single", "objects": []}
    # end if

    action = raw.get("action")
    if action not in VALID_ACTIONS:
        action = "IGNORE"
    # end if

    layout = raw.get("layout")
    if layout not in VALID_LAYOUTS:
        layout = "single"
    # end if

    topic = _clean_str(raw.get("topic_summary"), 40)
    if topic == None:
        topic = ""
    # end if

    scene = _clean_str(raw.get("scene_description"), 90)
    if scene == None:
        scene = (topic + ".").replace("..", ".") if topic != "" else ""
    # end if
    time_context = raw.get("time_context")
    if time_context not in VALID_TIME:
        time_context = "none"
    # end if
    meta = {
        "scene_description": scene if scene != None else "",
        "time_context": time_context,
        "semantic_analysis": _clean_semantic(raw.get("semantic_analysis"))
    }

    raw_objects = raw.get("objects")
    if not isinstance(raw_objects, list):
        raw_objects = []
    # end if

    if action in ["IGNORE", "PAUSE", "RESUME"]:
        return {"action": action, "topic_summary": topic, "layout": layout, "objects": [], **meta}
    # end if

    objects = []
    for i, item in enumerate(raw_objects[0:MAX_OBJECTS]):
        if not isinstance(item, dict):
            continue
        # end if
        obj_id = _clean_str(item.get("id"), 24)
        if obj_id == None:
            obj_id = "obj_" + str(i + 1)
        # end if
        label = _clean_str(item.get("label"), 32)
        if label == None:
            label = "Catatan"
        # end if
        stat = _clean_str(item.get("highlight_stat"), 12)
        role = item.get("role")
        if role not in VALID_ROLES:
            role = "object"
        # end if
        objects.append({
            "id": obj_id,
            "icon": _resolve_icon(item.get("icon"), transcript),
            "label": label,
            "highlight_stat": stat,
            "connect_to": None,
            "edge_label": None,
            "role": role
        })
    # end for

    beat_pack = _read_beat(raw, objects)
    if action == "UPDATE" and len(objects) == 0 and beat_pack["beat"] not in ["poster", "stat"]:
        action = "IGNORE"
    # end if
    if action == "UPDATE" and len(objects) == 0 and beat_pack["headline"] == "" and beat_pack["hero_stat"] == None:
        action = "IGNORE"
    # end if

    return {
        "action": action,
        "topic_summary": topic,
        "layout": layout,
        "objects": objects,
        **beat_pack,
        **meta
    }
# end def

# ---------------------------------------------------------------------------
# Provider resolution: deepseek -> anthropic -> offline (auto), or forced
# via G_SKETCHTALK_PROVIDER (deepseek | anthropic | off).
# ---------------------------------------------------------------------------

def resolve_provider():
    forced = (config.G_SKETCHTALK_PROVIDER or "auto").strip().lower()
    if forced in ["deepseek", "anthropic", "off"]:
        return forced
    # end if
    if config.G_DEEPSEEK_API_KEY != "":
        return "deepseek"
    # end if
    if config.G_ANTHROPIC_API_KEY != "" or os.environ.get("ANTHROPIC_AUTH_TOKEN", "") != "":
        return "anthropic"
    # end if
    return "off"
# end def

def active_model():
    if resolve_provider() == "deepseek":
        return config.G_SKETCHTALK_DS_MODEL
    # end if
    return config.G_SKETCHTALK_MODEL
# end def

# ---------------------------------------------------------------------------
# The DeepSeek-powered Visual Director (OpenAI-compatible chat completions,
# called through the stdlib so no extra package is required).
# ---------------------------------------------------------------------------

DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"

def _slide_brief(slide):
    if not isinstance(slide, dict):
        return "beat=none, kicker=, headline="
    # end if
    beat = str(slide.get("beat") or "scene")[0:12]
    kicker = str(slide.get("kicker") or "")[0:24]
    headline = str(slide.get("headline") or "")[0:80]
    return "beat=" + beat + ", kicker=" + kicker + ", headline=" + headline
# end def

def _runtime_user_text(transcript, lang, is_paused, canvas_objects, partial, slide):
    safe_canvas = []
    for obj in canvas_objects[0:MAX_OBJECTS]:
        if isinstance(obj, dict):
            safe_canvas.append({
                "id": str(obj.get("id") or ""),
                "icon": str(obj.get("icon") or ""),
                "label": str(obj.get("label") or ""),
                "highlight_stat": obj.get("highlight_stat")
            })
        # end if
    # end for
    text = ""
    text = text + "STATUS: is_paused=" + ("true" if is_paused else "false") + ", language=" + lang + "\n"
    text = text + "CURRENT_SLIDE: " + _slide_brief(slide) + "\n"
    text = text + "CURRENT_CANVAS_OBJECTS: " + json.dumps(safe_canvas, ensure_ascii=False) + "\n"
    text = text + ("TRANSCRIPT (PARSIAL): " if partial else "TRANSCRIPT: ") + transcript
    return text
# end def

def _ask_deepseek(transcript, lang, is_paused, canvas_objects, partial, slide=None):
    if config.G_DEEPSEEK_API_KEY == "":
        return None
    # end if

    user_text = _runtime_user_text(transcript, lang, is_paused, canvas_objects, partial, slide)

    # JSON mode requires the word "json" to appear in the prompt — the
    # Visual Director system prompt already demands STRICT JSON output.
    body = {
        "model": config.G_SKETCHTALK_DS_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT_BASE + _icon_prompt_text()},
            {"role": "user", "content": user_text}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.55,
        "max_tokens": 1024,
        "stream": False
    }

    req = urllib.request.Request(
        DEEPSEEK_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + config.G_DEEPSEEK_API_KEY
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        # end with
    except urllib.error.HTTPError as http_err:
        body_text = ""
        try:
            body_text = http_err.read().decode("utf-8", "replace")
        except Exception:
            body_text = ""
        # end try
        raise Exception("DeepSeek HTTP " + str(http_err.code) + ": " + body_text[0:400])
    # end try

    text = ""
    choices = data.get("choices") or []
    if len(choices) > 0:
        message = choices[0].get("message") or {}
        text = str(message.get("content") or "")
    # end if
    if text.strip() == "":
        return None
    # end if

    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    # end if
    try:
        parsed = json.loads(cleaned)
    except ValueError:
        print("[SketchTalk] DeepSeek returned non-JSON (" + str(len(cleaned)) + " chars): " + cleaned[0:200], flush=True)
        return None
    # end try
    return _validate_directive(parsed, transcript)
# end def

# ---------------------------------------------------------------------------
# The Claude-powered Visual Director.
# ---------------------------------------------------------------------------

def _ask_director(transcript, lang, is_paused, canvas_objects, partial, slide=None):
    client = _get_client()
    if client == None:
        return None
    # end if

    user_text = _runtime_user_text(transcript, lang, is_paused, canvas_objects, partial, slide)

    system_text = SYSTEM_PROMPT_BASE + _icon_prompt_text()

    response = client.beta.messages.create(
        model=config.G_SKETCHTALK_MODEL,
        max_tokens=1024,
        system=[{
            "type": "text",
            "text": system_text,
            "cache_control": {"type": "ephemeral"}
        }],
        messages=[{"role": "user", "content": user_text}],
        output_config={
            "effort": "medium",
            "format": {"type": "json_schema", "schema": DIRECTIVE_SCHEMA}
        },
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default"
    )

    if response.stop_reason == "refusal":
        return None
    # end if

    text = ""
    for block in response.content:
        if block.type == "text":
            text = text + block.text
        # end if
    # end for
    if text.strip() == "":
        return None
    # end if

    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    # end if
    try:
        parsed = json.loads(cleaned)
    except ValueError:
        return None
    # end try
    return _validate_directive(parsed, transcript)
# end def

# ---------------------------------------------------------------------------
# Proc class — the interface consumed by the view layer.
# ---------------------------------------------------------------------------

class sketchtalk_proc:

    mgdDB = database.get_db_conn(config.mainDB)

    # No look-alike characters (no B/8, S/5, I/L/1, O/0, 6/G) so room
    # codes read unambiguously when typed on another device.
    ROOM_ALPHABET = "ACDEFHJKMNPQRTUVWXYZ23479"

    def __init__(self, app=None):
        self.webapp = app
    # end def

    # ------------------------------------------------------------------
    # Presentation rooms: a mic page pushes directives into a room
    # document; presentation screens poll it.
    # ------------------------------------------------------------------
    def new_room_code(self):
        code = ""
        for _ in range(20):
            code = "".join(secrets.choice(self.ROOM_ALPHABET) for _ in range(6))
            if self.mgdDB.db_sketchtalk_room.find_one({"room_code": code, "is_deleted": False}, {"_id": 0}) == None:
                return code
            # end if
        # end for
        return "".join(secrets.choice(self.ROOM_ALPHABET) for _ in range(10))
    # end def

    def room_exists(self, room_code):
        room_code = (room_code or "").strip().upper()[0:12]
        if room_code == "":
            return False
        # end if
        return self.mgdDB.db_sketchtalk_room.find_one({"room_code": room_code, "is_deleted": False}, {"_id": 0}) != None
    # end def

    def ensure_room(self, room_code, create=True):
        room_code = (room_code or "").strip().upper()[0:12]
        if room_code == "":
            room_code = self.new_room_code()
        # end if
        existing = self.mgdDB.db_sketchtalk_room.find_one({"room_code": room_code, "is_deleted": False}, {"_id": 0})
        if existing != None:
            return room_code
        # end if
        if create == False:
            return None
        # end if
        rec = database.new(self.mgdDB, "db_sketchtalk_room")
        rec.put("room_code", room_code)
        rec.put("last_seq", 0)
        rec.put("last_source", "")
        rec.put("last_engine", "")
        rec.put("partial", False)
        rec.put("directive", {})
        rec.put("paused", False)
        rec.put("updated_at", time.strftime("%Y-%m-%d %H:%M:%S"))
        rec.insert()
        return room_code
    # end def

    def push_to_room(self, room_code, source, engine, directive, partial, instant):
        room_code = (room_code or "").strip().upper()[0:12]
        if room_code == "":
            return None
        # end if
        self.ensure_room(room_code, True)
        is_final = instant != True
        tier_seq_field = "final_seq" if is_final else "preview_seq"
        tier_doc_field = "final_directive" if is_final else "preview_directive"
        tier_label = "final" if is_final else "preview"
        # 1) content first, 2) ordering counter, 3) stamp the tier's seq —
        # readers can at worst see new content one beat early, never lose it.
        self.mgdDB.db_sketchtalk_room.update_one(
            {"room_code": room_code},
            {"$set": {
                tier_doc_field: directive,
                "last_source": source[0:40],
                "last_engine": engine,
                "partial": partial == True,
                "directive": directive,
                "paused": directive.get("action") == "PAUSE",
                "updated_at": time.strftime("%Y-%m-%d %H:%M:%S")
            }}
        )
        updated = self.mgdDB.db_sketchtalk_room.find_one_and_update(
            {"room_code": room_code},
            {"$inc": {"last_seq": 1}},
            {"_id": 0},
            return_document=ReturnDocument.AFTER
        )
        if updated == None:
            return None
        # end if
        seq = updated.get("last_seq", 0)
        self.mgdDB.db_sketchtalk_room.update_one(
            {"room_code": room_code},
            {"$set": {tier_seq_field: seq}}
        )
        print("[SketchTalk] room " + room_code + " <- push seq " + str(seq) + " " + tier_label + " source=" + source[0:20] + " action=" + str(directive.get("action")), flush=True)
        return {"seq": seq}
    # end def

    def room_state(self, room_code, since):
        room_code = (room_code or "").strip().upper()[0:12]
        room = self.mgdDB.db_sketchtalk_room.find_one(
            {"room_code": room_code, "is_deleted": False}, {"_id": 0}
        )
        if room == None:
            return {"seq": 0, "source": "", "engine": "", "directive": None, "partial": False}
        # end if
        # Deliver the newest tier that is newer than the poller's seq.
        # A final (AI) result always beats a newer-numbered stale preview,
        # so screens never flash sticky-notes over finished AI scenes.
        final_seq = room.get("final_seq", 0)
        preview_seq = room.get("preview_seq", 0)
        chosen = None
        if final_seq > since:
            chosen = {"seq": final_seq, "directive": room.get("final_directive"), "partial": False}
        # end if
        if preview_seq > since and (chosen == None or preview_seq > chosen["seq"]):
            chosen = {"seq": preview_seq, "directive": room.get("preview_directive"), "partial": True}
        # end if
        if chosen == None or chosen["directive"] == None:
            return {"seq": since, "source": "", "engine": "", "directive": None, "partial": False}
        # end if
        return {
            "seq": chosen["seq"],
            "source": room.get("last_source", ""),
            "engine": room.get("last_engine", ""),
            "directive": chosen["directive"],
            "partial": chosen["partial"]
        }
    # end def

    def interpret(self, transcript, lang, is_paused, canvas_objects, partial, instant, room="", source="", slide=None):
        lower = (transcript or "").lower()

        # Deterministic voice-command layer (spec: STATE & VOICE COMMANDS).
        if is_paused:
            if _contains_any(lower, RESUME_WORDS):
                print("[SketchTalk] command: RESUME keyword matched", flush=True)
                return {"status": "SUCCESS", "engine": "command", "directive": {"action": "RESUME", "topic_summary": "", "layout": "single", "objects": []}}
            # end if
            print("[SketchTalk] command: paused, transcript ignored", flush=True)
            return {"status": "SUCCESS", "engine": "command", "directive": {"action": "IGNORE", "topic_summary": "", "layout": "single", "objects": []}}
        # end if
        if _contains_any(lower, PAUSE_WORDS):
            print("[SketchTalk] command: PAUSE keyword matched", flush=True)
            return {"status": "SUCCESS", "engine": "command", "directive": {"action": "PAUSE", "topic_summary": "", "layout": "single", "objects": []}}
        # end if
        if _contains_any(lower, CLEAR_PHRASES):
            print("[SketchTalk] command: CLEAR keyword matched", flush=True)
            return {"status": "SUCCESS", "engine": "command", "directive": {"action": "CLEAR_AND_DRAW", "topic_summary": "", "layout": "single", "objects": []}}
        # end if

        greeting = _match_greeting(lower)
        if greeting != None:
            print("[SketchTalk] greeting: " + greeting["icon"] + " '" + greeting["label"] + "'", flush=True)
            return {"status": "SUCCESS", "engine": "fallback", "directive": _greeting_directive(greeting)}
        # end if

        directive = None
        engine = "fallback"
        provider = "off" if instant else resolve_provider()
        started = time.time()
        if provider == "deepseek":
            try:
                directive = _ask_deepseek(transcript, lang, is_paused, canvas_objects, partial, slide)
                if directive != None:
                    engine = "deepseek"
                # end if
            except Exception as e:
                print("[SketchTalk] DeepSeek engine FAILED, using fallback -> " + str(e), flush=True)
            # end try
        elif provider == "anthropic":
            try:
                directive = _ask_director(transcript, lang, is_paused, canvas_objects, partial, slide)
                if directive != None:
                    engine = "claude"
                # end if
            except Exception as e:
                print("[SketchTalk] Claude engine FAILED, using fallback -> " + str(e), flush=True)
            # end try
        else:
            if instant:
                # Instant previews skip the AI on purpose (speed feature).
                print("[SketchTalk] instant preview: local engine by design (bukan error)", flush=True)
            else:
                print("[SketchTalk] no AI provider configured, using offline fallback", flush=True)
            # end if
        # end if
        # Policy enforcement: IGNORE is only valid for ultra-short
        # interjections. If the engine tries to ignore anything longer,
        # force an illustration through the fallback so every statement
        # the speaker makes appears on screen.
        if directive != None and directive.get("action") == "IGNORE":
            word_count = len(re.findall(r"[a-zA-Z]+", transcript))
            if word_count > 2:
                print("[SketchTalk] policy enforce: engine returned IGNORE for a " + str(word_count) + "-word transcript -> forcing illustration via fallback", flush=True)
                directive = None
            # end if
        # end if
        if directive == None:
            directive = _fallback_director(transcript, canvas_objects)
        # end if

        elapsed = round(time.time() - started, 2)
        icons = []
        for obj in directive.get("objects", []):
            icons.append(str(obj.get("icon")))
        # end for
        print("[SketchTalk] result: engine=" + engine + " action=" + str(directive.get("action")) + " beat=" + str(directive.get("beat")) + " layout=" + str(directive.get("layout")) + " time=" + str(directive.get("time_context")) + " objects=" + str(icons) + " (" + str(elapsed) + "s)", flush=True)
        # Per-object text diagnostics: the browser card wraps labels wider
        # than ~196px onto two fixed lines and clamps labels over 32 chars.
        for obj in directive.get("objects", []):
            label = str(obj.get("label") or "")
            est_px = len(label) * 10
            fit = "OK"
            if len(label) > 30:
                fit = "CLAMPED-32chars"
            elif est_px > 196:
                fit = "WRAP-2lines"
            # end if
            print("[SketchTalk]   card " + str(obj.get("id")) + ": icon=" + str(obj.get("icon")) + " label='" + label + "' (" + str(len(label)) + " ch, ~" + str(est_px) + "px, " + fit + ") stat=" + str(obj.get("highlight_stat")) + " role=" + str(obj.get("role")), flush=True)
        # end for
        if directive.get("action") == "IGNORE":
            print("[SketchTalk] policy: IGNORE hanya untuk interjeksi <=2 kata; ucapan lain WAJIB jadi ilustrasi", flush=True)
        # end if

        envelope = {"status": "SUCCESS", "engine": engine, "directive": directive}
        if instant:
            envelope["instant"] = True
        # end if
        if room != "":
            pushed = self.push_to_room(room, source, engine, directive, partial, instant)
            if pushed != None:
                envelope["room_seq"] = pushed["seq"]
            # end if
        # end if
        return envelope
    # end def
# end class
