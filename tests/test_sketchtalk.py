import os
import sys

# Tests run against a scratch database so local data is never touched
os.environ["MONGO_DB_NAME"] = "slapz_test"

sys.path.append("slapz102_core")
sys.path.append("slapz102_modules")
sys.path.append("slapz102_settings")
sys.path.append("slapz102_stdlib")
sys.path.append("slapz102_storage")

import json

import tempfile

import pytest

from slapz102_core import config
from slapz102_core import database
import server

# Never hit a real LLM API from the test suite: force the deterministic
# fallback engine for every test here.
config.G_ANTHROPIC_API_KEY = ""
config.G_DEEPSEEK_API_KEY = ""
config.G_SKETCHTALK_PROVIDER = "auto"
os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)

# Missing-icon reports from tests go to a scratch folder, never the real
# training-model-folder.
import sketchtalk.sketchtalk_proc as _proc
_proc.MISSING_ICONS_DIR = os.path.join(tempfile.gettempdir(), "sk_missing_icons_test")


@pytest.fixture()
def client():
    db = database.get_db_conn(config.mainDB)
    db.client.drop_database(config.mainDB)
    server.app.config["TESTING"] = True
    with server.app.test_client() as client:
        yield client
    # end with
# end def


def _get_csrf_token(client):
    html = client.get("/sketchtalk").data.decode("utf-8")
    marker = 'window.SK_CONFIG = {'
    start = html.find(marker)
    token_marker = 'csrfToken: "'
    start = html.find(token_marker, start) + len(token_marker)
    end = html.find('"', start)
    return html[start:end]
# end def


def _interpret(client, transcript, canvas=None, is_paused=False):
    token = _get_csrf_token(client)
    payload = {
        "transcript": transcript,
        "lang": "id-ID",
        "is_paused": is_paused,
        "canvas_objects": canvas or []
    }
    return client.post(
        "/sketchtalk/interpret",
        data={"csrf_token": token, "payload": json.dumps(payload)}
    )
# end def


def test_page_renders(client):
    res = client.get("/sketchtalk")
    assert res.status_code == 200
    html = res.data.decode("utf-8")
    assert "sk-canvas" in html
    assert "Mulai berbicara" in html
    assert "csrfToken" in html
# end def


def test_interpret_requires_csrf(client):
    payload = json.dumps({"transcript": "test", "canvas_objects": []})
    res = client.post("/sketchtalk/interpret", data={"payload": payload})
    assert res.status_code == 403
# end def


def test_interpret_rejects_malformed_payload(client):
    token = _get_csrf_token(client)
    res = client.post(
        "/sketchtalk/interpret",
        data={"csrf_token": token, "payload": "{not json"}
    )
    assert res.status_code == 400
# end def


def test_engine_ignore_is_overridden_for_real_statements(monkeypatch):
    # Even if the AI engine wrongly returns IGNORE for a real statement,
    # the proc must force an illustration (draw-everything guarantee).
    import sketchtalk.sketchtalk_proc as proc
    monkeypatch.setattr(proc, "_ask_deepseek", lambda *a, **k: {
        "action": "IGNORE", "topic_summary": "", "layout": "single", "objects": []
    })
    monkeypatch.setattr(proc.config, "G_DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setattr(proc.config, "G_ANTHROPIC_API_KEY", "")
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    p = proc.sketchtalk_proc()
    result = p.interpret("Oke gua mau tahu", "id-ID", False, [], False, False)
    assert result["directive"]["action"] in ["CLEAR_AND_DRAW", "UPDATE"]
    assert len(result["directive"]["objects"]) >= 1
    icons = [obj["icon"] for obj in result["directive"]["objects"]]
    assert "search" in icons  # "mau tahu" -> magnifier pictogram
# end def


def test_instant_mode_skips_ai(monkeypatch):
    import sketchtalk.sketchtalk_proc as proc

    def boom(*a, **k):
        raise AssertionError("AI engine must not be called in instant mode")
    # end def

    monkeypatch.setattr(proc, "_ask_deepseek", boom)
    monkeypatch.setattr(proc, "_ask_director", boom)
    monkeypatch.setattr(proc.config, "G_DEEPSEEK_API_KEY", "sk-test")
    monkeypatch.setattr(proc.config, "G_ANTHROPIC_API_KEY", "")
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    p = proc.sketchtalk_proc()
    result = p.interpret("Kemarin gua naik kereta ke Bandung", "id-ID", False, [], True, True)
    assert result["instant"] == True
    assert result["engine"] == "fallback"
    assert len(result["directive"]["objects"]) >= 1
# end def


def test_icon_whitelist_auto_syncs_with_library():
    import re
    from sketchtalk.sketchtalk_proc import available_icons
    js = open("static/sketchtalk/sketchtalk-icons.js", encoding="utf-8").read()
    names = set(re.findall(r"^\s*'([a-z0-9-]+)':\s*\[", js, re.MULTILINE))
    assert len(names) > 60
    assert set(available_icons()) == names
    # user-drawn additions are picked up automatically
    for icon in ["sunrise", "sun", "sunset", "moon", "sabbath", "welcome", "cake"]:
        assert icon in names
    # end for
# end def


def test_missing_icons_are_recorded(tmp_path, monkeypatch):
    import sketchtalk.sketchtalk_proc as proc
    monkeypatch.setattr(proc, "MISSING_ICONS_DIR", str(tmp_path))
    monkeypatch.setattr(proc, "_MISSING_ICONS", {"missing": {}, "fuzzy": {}})
    out = proc._validate_directive({
        "action": "CLEAR_AND_DRAW",
        "topic_summary": "Masak",
        "time_context": "present",
        "layout": "single",
        "objects": [
            {"id": "obj_1", "icon": "kompor", "label": "Masak Pakai Kompor",
             "highlight_stat": None, "connect_to": None, "edge_label": None, "role": "object"}
        ]
    }, "gua masak pakai kompor")
    assert out["objects"][0]["icon"] == "sticky-note"
    report = json.load(open(os.path.join(str(tmp_path), "missing-icons.json"), encoding="utf-8"))
    assert "kompor" in report["missing"]
    assert report["missing"]["kompor"]["count"] == 1
    assert "kompor" in open(os.path.join(str(tmp_path), "missing-icons.log"), encoding="utf-8").read()
# end def


def test_home_and_rooms(client):
    # Home landing renders
    res = client.get("/")
    assert res.status_code == 200
    assert "SketchTalk" in res.data.decode("utf-8")

    # Creating a room redirects to a stage URL with a code
    token_html = res.data.decode("utf-8")
    marker = 'name="csrf_token" value="'
    start = token_html.find(marker) + len(marker)
    token = token_html[start:token_html.find('"', start)]
    res = client.post("/sketchtalk/new", data={"csrf_token": token})
    assert res.status_code == 302
    assert "/sketchtalk/" in res.headers.get("Location", "")

    # Stage and mic pages render with the room code
    code = res.headers.get("Location", "").rstrip("/").split("/")[-1]
    res = client.get("/sketchtalk/" + code)
    assert res.status_code == 200
    assert code in res.data.decode("utf-8")
    res = client.get("/mic/" + code)
    assert res.status_code == 200
    assert code in res.data.decode("utf-8")

    # Mic jump helper
    res = client.get("/mic?code=" + code)
    assert res.status_code == 302
    assert ("/mic/" + code) in res.headers.get("Location", "")
# end def


def test_mic_unknown_room_does_not_create(client):
    # A typo in the room code must never silently create a parallel room.
    res = client.get("/mic/ZZZZZZ")
    assert res.status_code == 302
    location = res.headers.get("Location", "")
    assert location.startswith("/?error=")
    # end def checks redirect home


def test_room_codes_have_no_lookalike_chars(client):
    from sketchtalk.sketchtalk_proc import sketchtalk_proc
    proc = sketchtalk_proc()
    for _ in range(10):
        code = proc.new_room_code()
        for ch in "B8S5IO01L6G":
            assert ch not in code
        # end for
    # end for
# end def


def test_room_push_and_state(client):
    from sketchtalk.sketchtalk_proc import sketchtalk_proc
    proc = sketchtalk_proc()
    code = proc.ensure_room("TESTR1")
    assert code == "TESTR1"

    directive = {"action": "CLEAR_AND_DRAW", "topic_summary": "Ke Jerman", "time_context": "past",
                 "layout": "flow", "objects": [
                     {"id": "obj_1", "icon": "airplane", "label": "Terbang", "highlight_stat": None,
                      "connect_to": None, "edge_label": None, "role": "vehicle"}]}
    pushed = proc.push_to_room(code, "mic-test", "deepseek", directive, False, False)
    assert pushed != None and pushed["seq"] >= 1

    state = proc.room_state(code, 0)
    assert state["seq"] == pushed["seq"]
    assert state["source"] == "mic-test"
    assert state["directive"]["objects"][0]["icon"] == "airplane"

    # Polling with 'since' at the current seq reports nothing new
    state = proc.room_state(code, pushed["seq"])
    assert state["directive"] == None
# end def


def test_room_final_beats_stale_preview():
    from sketchtalk.sketchtalk_proc import sketchtalk_proc
    proc = sketchtalk_proc()
    code = proc.ensure_room("TIER1")

    preview = {"action": "CLEAR_AND_DRAW", "topic_summary": "Sementara", "layout": "single",
               "objects": [{"id": "obj_1", "icon": "sticky-note", "label": "Sementara",
                            "highlight_stat": None, "connect_to": None, "edge_label": None, "role": "object"}]}
    final = {"action": "CLEAR_AND_DRAW", "topic_summary": "Rajin Menabung", "layout": "single",
             "objects": [{"id": "obj_1", "icon": "wallet", "label": "Rajin Menabung",
                          "highlight_stat": None, "connect_to": None, "edge_label": None, "role": "symbol"}]}

    p1 = proc.push_to_room(code, "mic-a", "fallback", preview, True, True)
    f1 = proc.push_to_room(code, "mic-a", "deepseek", final, False, False)
    assert f1["seq"] > p1["seq"]

    # Poller behind both: the AI final wins; the sticky-note preview is skipped.
    state = proc.room_state(code, 0)
    assert state["directive"]["objects"][0]["icon"] == "wallet"
    assert state["partial"] == False

    # Up to date: nothing new.
    state = proc.room_state(code, f1["seq"])
    assert state["directive"] == None

    # A NEW preview while the speaker continues still shows quickly.
    p2 = proc.push_to_room(code, "mic-a", "fallback", preview, True, True)
    assert p2["seq"] > f1["seq"]
    state = proc.room_state(code, f1["seq"])
    assert state["directive"] != None
    assert state["partial"] == True
# end def


def test_interpret_pushes_to_room(client):
    token_html = client.get("/").data.decode("utf-8")
    marker = 'name="csrf_token" value="'
    start = token_html.find(marker) + len(marker)
    token = token_html[start:token_html.find('"', start)]
    payload = {
        "transcript": "Kemarin gua ke German",
        "lang": "id-ID",
        "is_paused": False,
        "partial": False,
        "room": "TESTR2",
        "source": "mic-test",
        "seq": 1,
        "canvas_objects": []
    }
    res = client.post(
        "/sketchtalk/interpret",
        data={"csrf_token": token, "payload": json.dumps(payload)}
    )
    assert res.status_code == 200
    body = res.get_json()
    assert body.get("room_seq", 0) >= 1

    res = client.get("/sketchtalk/room/TESTR2/state?since=0")
    state = res.get_json()
    assert state["directive"] != None
    assert state["source"] == "mic-test"
# end def


def test_short_interjection_is_ignored(client):
    res = _interpret(client, "Oke ya")
    assert res.status_code == 200
    body = res.get_json()
    assert body["status"] == "SUCCESS"
    assert body["directive"]["action"] == "IGNORE"
    assert body["directive"]["objects"] == []
# end def


def test_simple_greetings_draw_one_symbol(client):
    cases = [
        ("Selamat pagi", "sunrise", "Pagi"),
        ("selamat sore", "sunset", "Sore"),
        ("Selamat siang", "sun", "Siang"),
        ("Selamat malam", "moon", "Malam"),
        ("Good evening", "moon", "Evening"),
        ("good morning", "sunrise", "Morning"),
        ("Selamat Hari Sabat", "sabbath", "Hari Sabat"),
        ("happy sabbath", "sabbath", "Sabbath"),
        ("Selamat datang", "welcome", "Datang"),
        ("Selamat ulang tahun", "cake", "Ulang Tahun")
    ]
    for text, icon, label in cases:
        directive = _interpret(client, text).get_json()["directive"]
        assert directive["action"] == "CLEAR_AND_DRAW"
        assert directive["layout"] == "single"
        assert len(directive["objects"]) == 1
        assert directive["objects"][0]["icon"] == icon
        assert directive["objects"][0]["label"] == label
    # end for
# end def


def test_greeting_with_a_real_topic_keeps_the_topic(client):
    directive = _interpret(client, "Selamat pagi, masalah utama kita adalah biaya operasional").get_json()["directive"]
    icons = []
    for obj in directive["objects"]:
        icons.append(obj["icon"])
    # end for
    assert "triangle-alert" in icons
    assert "sunrise" not in icons
# end def


def test_number_sentence_becomes_a_stat_slide(client):
    directive = _interpret(client, "Omzet kita naik 60 persen").get_json()["directive"]
    assert directive["beat"] == "stat"
    assert directive["hero_stat"] == "60%"
    assert directive["headline"] != ""
    assert directive["layout"] == "single"
# end def


def test_poster_beat_survives_without_objects():
    from sketchtalk.sketchtalk_proc import _validate_directive
    raw = {
        "action": "CLEAR_AND_DRAW",
        "topic_summary": "Biaya",
        "time_context": "present",
        "layout": "single",
        "beat": "poster",
        "kicker": "Masalah",
        "headline": "Biaya operasional membengkak",
        "hero_stat": None,
        "objects": []
    }
    out = _validate_directive(raw)
    assert out["action"] == "CLEAR_AND_DRAW"
    assert out["beat"] == "poster"
    assert out["headline"] == "Biaya operasional membengkak"
    assert out["objects"] == []
    assert out["kicker"] == "Masalah"
# end def


def test_unknown_beat_falls_back_to_scene():
    from sketchtalk.sketchtalk_proc import _validate_directive
    raw = {
        "action": "CLEAR_AND_DRAW",
        "topic_summary": "Jalan",
        "layout": "flow",
        "beat": "carousel",
        "headline": "",
        "objects": [
            {"id": "obj_1", "icon": "train", "label": "Kereta", "highlight_stat": None, "role": "vehicle"}
        ]
    }
    out = _validate_directive(raw)
    assert out["beat"] == "scene"
    assert out["objects"][0]["icon"] == "train"
# end def


def test_blank_slide_does_not_clear_the_screen():
    from sketchtalk.sketchtalk_proc import _hold_screen_if_blank
    kept = _hold_screen_if_blank({
        "action": "CLEAR_AND_DRAW",
        "topic_summary": "",
        "layout": "single",
        "beat": "scene",
        "headline": "",
        "hero_stat": None,
        "objects": []
    })
    assert kept["action"] == "IGNORE"

    shown = _hold_screen_if_blank({
        "action": "CLEAR_AND_DRAW",
        "topic_summary": "Tiga",
        "layout": "single",
        "beat": "stat",
        "headline": "Tiga pokok",
        "hero_stat": "3",
        "objects": []
    })
    assert shown["action"] == "CLEAR_AND_DRAW"

    cleared = _hold_screen_if_blank({
        "action": "CLEAR_AND_DRAW",
        "topic_summary": "",
        "objects": [],
        "cleared": True
    })
    assert cleared["action"] == "CLEAR_AND_DRAW"
# end def


def test_long_greeting_becomes_illustration(client):
    res = _interpret(client, "Selamat pagi teman-teman, hari ini kita akan mulai presentasi ya")
    assert res.status_code == 200
    body = res.get_json()
    assert body["status"] == "SUCCESS"
    assert body["directive"]["action"] in ["CLEAR_AND_DRAW", "UPDATE"]
    assert len(body["directive"]["objects"]) >= 1
# end def


def test_problem_sentence_draws_single(client):
    res = _interpret(client, "Masalah utama bisnis kita sekarang adalah biaya operasional yang membengkak")
    assert res.status_code == 200
    directive = res.get_json()["directive"]
    assert directive["action"] == "CLEAR_AND_DRAW"
    assert len(directive["objects"]) >= 1
    assert directive["objects"][0]["icon"] == "triangle-alert"
# end def


def test_update_with_stat_and_comparison(client):
    canvas = [
        {"id": "obj_1", "icon": "triangle-alert", "label": "Biaya", "highlight_stat": None}
    ]
    res = _interpret(
        client,
        "Tapi dengan sistem otomasi baru, kita bisa memangkas biaya hingga 60 persen",
        canvas=canvas
    )
    directive = res.get_json()["directive"]
    assert directive["action"] == "UPDATE"
    assert len(directive["objects"]) == 2
    stats = [obj["highlight_stat"] for obj in directive["objects"]]
    assert "60%" in stats
    assert directive["layout"] == "comparison"
# end def


def test_canvas_never_exceeds_four_objects(client):
    canvas = [
        {"id": "obj_1", "icon": "lightbulb", "label": "Ide", "highlight_stat": None},
        {"id": "obj_2", "icon": "users", "label": "Tim", "highlight_stat": None},
        {"id": "obj_3", "icon": "server", "label": "Sistem", "highlight_stat": None},
        {"id": "obj_4", "icon": "target", "label": "Target", "highlight_stat": None}
    ]
    res = _interpret(client, "Dan yang paling penting keamanan data pelanggan kita", canvas=canvas)
    directive = res.get_json()["directive"]
    assert directive["action"] == "CLEAR_AND_DRAW"
    assert len(directive["objects"]) <= 4
# end def


def test_pause_and_resume_commands(client):
    res = _interpret(client, "Sebentar, BERHENTI dulu ya saya mau minum")
    assert res.get_json()["directive"]["action"] == "PAUSE"

    res = _interpret(client, "apa kabar semua", is_paused=True)
    assert res.get_json()["directive"]["action"] == "IGNORE"

    res = _interpret(client, "Oke LANJUTKAN presentasinya", is_paused=True)
    assert res.get_json()["directive"]["action"] == "RESUME"
# end def


def test_clear_command(client):
    res = _interpret(client, "Kesimpulan selanjutnya hapus layar")
    assert res.get_json()["directive"]["action"] == "CLEAR_AND_DRAW"
    assert res.get_json()["directive"]["objects"] == []
# end def


def test_transition_triggers_clear(client):
    canvas = [
        {"id": "obj_1", "icon": "triangle-alert", "label": "Biaya", "highlight_stat": None}
    ]
    res = _interpret(client, "Selanjutnya, tim kita akan fokus ke target sukses global", canvas=canvas)
    directive = res.get_json()["directive"]
    assert directive["action"] == "CLEAR_AND_DRAW"
    icons = [obj["icon"] for obj in directive["objects"]]
    assert "users" in icons
    assert "target" in icons
# end def


def test_validate_directive_sanitizes_and_clamps():
    from sketchtalk.sketchtalk_proc import _validate_directive
    raw = {
        "action": "UPDATE",
        "topic_summary": "Topik <script>alert(1)</script>",
        "layout": "diagonal",
        "objects": [
            {
                "id": "obj_1",
                "icon": "alert-triangle",
                "label": "Biaya <b>membengkak</b> sekali dari kantor cabang utama",
                "highlight_stat": "60 persen",
                "connect_to": "obj_9",
                "edge_label": None
            },
            {
                "id": "obj_2",
                "icon": "not-a-real-icon",
                "label": "",
                "highlight_stat": None,
                "connect_to": "obj_1",
                "edge_label": None
            }
        ] + [
            {"id": "obj_" + str(n), "icon": "star", "label": "X", "highlight_stat": None, "connect_to": None, "edge_label": None}
            for n in range(3, 9)
        ]
    }
    out = _validate_directive(raw)
    assert out["action"] == "UPDATE"
    assert out["layout"] == "single"  # invalid layout coerced
    assert len(out["objects"]) == 4   # capped at 4
    assert out["objects"][0]["icon"] == "triangle-alert"  # alias resolved
    assert "<" not in out["objects"][0]["label"]
    assert len(out["objects"][0]["label"]) <= 32
    assert out["objects"][0]["highlight_stat"] == "60 persen"[:12]
    assert out["objects"][0]["connect_to"] == None  # arrows retired: always None
    assert out["objects"][1]["connect_to"] == None
    assert out["objects"][1]["icon"] == "sticky-note"  # unknown icon fallback
    assert "<script>" not in out["topic_summary"]
# end def


def test_fallback_director_flow_layout_without_arrows():
    from sketchtalk.sketchtalk_proc import _fallback_director
    directive = _fallback_director("Dari server data mengalir ke database lalu menuju target akhir", [])
    assert directive["action"] == "CLEAR_AND_DRAW"
    assert directive["layout"] in ["flow", "hub_spoke"]
    assert len(directive["objects"]) >= 2
    for obj in directive["objects"]:
        assert obj["connect_to"] == None
    # end for
# end def


def test_fallback_travel_to_country_uses_airplane_and_flag():
    from sketchtalk.sketchtalk_proc import _fallback_director
    directive = _fallback_director("Kemarin gua ke German", [])
    icons = [obj["icon"] for obj in directive["objects"]]
    assert "airplane" in icons
    assert "flag-germany" in icons
    assert directive["layout"] == "flow"
    for obj in directive["objects"]:
        assert obj["connect_to"] == None
    # end for
# end def


def test_fallback_train_to_city_uses_map_pin():
    from sketchtalk.sketchtalk_proc import _fallback_director
    directive = _fallback_director("Kemarin gua naik kereta ke Bandung", [])
    icons = [obj["icon"] for obj in directive["objects"]]
    assert "train" in icons
    assert "map-pin" in icons
    labels = [obj["label"] for obj in directive["objects"]]
    assert "Bandung" in labels
# end def


def test_fallback_school_and_football_single_pictograms():
    from sketchtalk.sketchtalk_proc import _fallback_director
    directive = _fallback_director("Waktu gua masih sekolah", [])
    assert directive["objects"][0]["icon"] == "school-kid"
    assert directive["layout"] == "single"

    directive = _fallback_director("Waktu kecil gua suka main bola", [])
    assert directive["objects"][0]["icon"] == "football"
# end def


def test_fallback_study_abroad_connects_cap_to_flag():
    from sketchtalk.sketchtalk_proc import _fallback_director
    directive = _fallback_director("Tahun depan gua mau kuliah di Jerman", [])
    icons = [obj["icon"] for obj in directive["objects"]]
    assert "graduation-cap" in icons
    assert "flag-germany" in icons
    assert directive["layout"] == "flow"
# end def


def test_fallback_scene_metadata_time_and_roles():
    from sketchtalk.sketchtalk_proc import _fallback_director
    directive = _fallback_director("Kemarin gua ke German", [])
    assert directive["time_context"] == "past"
    assert directive["scene_description"] != ""
    roles = {obj["icon"]: obj["role"] for obj in directive["objects"]}
    assert roles.get("airplane") == "vehicle"
    assert roles.get("flag-germany") == "destination"
    assert directive["semantic_analysis"]["location"] == "German".title() or directive["semantic_analysis"]["location"] != ""

    directive = _fallback_director("Besok gua mau pergi ke Jepang", [])
    assert directive["time_context"] == "future"

    directive = _fallback_director("Sekarang gua lagi kerja di kantor", [])
    assert directive["time_context"] == "present"
# end def


def test_validate_directive_coerces_scene_fields():
    from sketchtalk.sketchtalk_proc import _validate_directive
    raw = {
        "action": "CLEAR_AND_DRAW",
        "topic_summary": "Ke Jerman",
        "layout": "flow",
        "time_context": "yesterday",
        "scene_description": "Pesawat <b>terbang</b> menuju Jerman pada masa lalu yang cukup panjang sekali",
        "semantic_analysis": {"subject": "Gua", "action": "Bepergian", "object": "Jerman", "location": "Jerman"},
        "objects": [
            {"id": "obj_1", "icon": "airplane", "label": "Terbang", "highlight_stat": None,
             "connect_to": "obj_2", "edge_label": None, "role": "nonsense"},
            {"id": "obj_2", "icon": "flag-germany", "label": "Jerman", "highlight_stat": None,
             "connect_to": None, "edge_label": None, "role": "destination"}
        ],
        "validation_result": {"semantic_accuracy": True, "icons_available": True, "composition_clear": True}
    }
    out = _validate_directive(raw)
    assert out["time_context"] == "none"  # invalid enum coerced
    assert "<" not in out["scene_description"]
    assert len(out["scene_description"]) <= 90
    assert out["objects"][0]["role"] == "object"  # invalid role coerced
    assert out["objects"][1]["role"] == "destination"
    assert out["semantic_analysis"]["subject"] == "Gua"
# end def


def test_provider_resolution():
    import sketchtalk.sketchtalk_proc as proc

    # No keys anywhere -> offline fallback engine.
    assert proc.resolve_provider() == "off"

    # A DeepSeek key wins the auto order.
    proc.config.G_DEEPSEEK_API_KEY = "sk-test"
    assert proc.resolve_provider() == "deepseek"
    proc.config.G_DEEPSEEK_API_KEY = ""

    # Anthropic env token is used when DeepSeek is absent.
    os.environ["ANTHROPIC_AUTH_TOKEN"] = "tok-test"
    assert proc.resolve_provider() == "anthropic"
    os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)

    # Explicit forcing beats auto detection.
    proc.config.G_SKETCHTALK_PROVIDER = "off"
    proc.config.G_DEEPSEEK_API_KEY = "sk-test"
    assert proc.resolve_provider() == "off"
    proc.config.G_DEEPSEEK_API_KEY = ""
    proc.config.G_SKETCHTALK_PROVIDER = "auto"
# end def
