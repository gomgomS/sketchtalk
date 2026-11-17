import sys

sys.path.append("slapz102_core")
sys.path.append("slapz102_modules")
sys.path.append("slapz102_settings")
sys.path.append("slapz102_stdlib")
sys.path.append("slapz102_storage")

import json
import os

from flask import jsonify, redirect, render_template, request, url_for

from slapz102_core import config
from slapz102_stdlib import csrf
from slapz102_stdlib import sanitize

from sketchtalk.sketchtalk_proc import sketchtalk_proc
from sketchtalk.sketchtalk_proc import active_model
from sketchtalk.sketchtalk_proc import resolve_provider

# ---------------------------------------------------------------------------
# SKETCHTALK MODULE — view / render layer.
#
# html_home            -> landing page: create a presentation room or join
#                         an existing room as a microphone
# html_create_room     -> POST: make a new room, redirect to the stage
# html_mic_jump        -> GET ?code=ROOM -> redirect to /mic/<room>
# html_stage           -> the presentation screen (canvas) for a room
# html_mic             -> the mic-only page for a room
# json_interpret       -> POST transcript -> Visual Director JSON directive
#                         (optionally pushed into the room)
# json_room_state      -> GET latest room directive for screen polling
# ---------------------------------------------------------------------------

def _base_data():
    return {
        "site_name": config.G_SITE_NAME,
        "csrf_token": csrf.get_token(),
        "og_image": config.G_PUBLIC_SITE_URL + config.G_OG_IMAGE_PATH,
        "og_url": config.G_PUBLIC_SITE_URL + "/"
    }
# end def

def html_home():
    data = _base_data()
    data["form_error"] = (request.args.get("error") or "").strip()
    return render_template("sketchtalk_home.html", data=data)
# end def

def html_create_room():
    if not csrf.validate():
        return redirect(url_for("sketchtalk_blueprint.home", error="Invalid session, please try again"))
    # end if
    proc = sketchtalk_proc()
    code = proc.ensure_room("")
    return redirect(url_for("sketchtalk_blueprint.stage", room=code))
# end def

def html_mic_jump():
    code = sanitize.clean_html((request.args.get("code") or "").strip().upper())[0:12]
    if code == "":
        return redirect(url_for("sketchtalk_blueprint.home"))
    # end if
    return redirect(url_for("sketchtalk_blueprint.mic", room=code))
# end def

def html_stage(room):
    proc = sketchtalk_proc()
    code = proc.ensure_room(room or "", True)
    data = _base_data()
    provider = resolve_provider()
    data["ai_enabled"] = provider != "off"
    data["ai_provider"] = provider
    data["ai_model"] = active_model()
    data["room"] = code
    return render_template("sketchtalk.html", data=data)
# end def

def html_mic(room):
    proc = sketchtalk_proc()
    code = proc.ensure_room((room or "").strip().upper(), False)
    if code == None:
        # A typo on the mic page must never create a parallel room —
        # send the presenter back to the landing page with an explanation.
        return redirect(url_for("sketchtalk_blueprint.home", error="Room tidak ditemukan. Periksa kode di layar presentasi lalu buka ulang tautan mic-nya."))
    # end if
    data = _base_data()
    provider = resolve_provider()
    data["ai_enabled"] = provider != "off"
    data["ai_provider"] = provider
    data["ai_model"] = active_model()
    data["room"] = code
    return render_template("sketchtalk_mic.html", data=data)
# end def

def json_room_state(room):
    proc = sketchtalk_proc()
    since_raw = (request.args.get("since") or "0").strip()
    if not since_raw.isdigit():
        since_raw = "0"
    # end if
    state = proc.room_state(sanitize.clean_html(room)[0:12], int(since_raw))
    if state.get("directive") != None:
        print("[SketchTalk] room " + str(room).upper() + " -> delivered seq " + str(state.get("seq")) + " source=" + str(state.get("source")) + " to stage poll", flush=True)
    # end if
    return jsonify(state)
# end def

def json_interpret():
    if not csrf.validate():
        print("[SketchTalk] interpret REJECTED (403): csrf token mismatch — reload the mic page", flush=True)
        return jsonify({"status": "ERROR", "desc": "Invalid session, reload the page"}), 403
    # end if

    raw_payload = (request.form.get("payload") or "").strip()
    if raw_payload == "":
        return jsonify({"status": "ERROR", "desc": "Empty payload"}), 400
    # end if

    try:
        payload = json.loads(raw_payload)
    except ValueError:
        return jsonify({"status": "ERROR", "desc": "Malformed payload"}), 400
    # end try
    if not isinstance(payload, dict):
        return jsonify({"status": "ERROR", "desc": "Malformed payload"}), 400
    # end if

    # Every user-supplied string is sanitized before it reaches the proc.
    transcript = sanitize.clean_html(str(payload.get("transcript") or ""))[0:600]
    lang = sanitize.clean_html(str(payload.get("lang") or "id-ID"))[0:10]
    is_paused = payload.get("is_paused") == True
    partial = payload.get("partial") == True
    instant = payload.get("instant") == True
    flush = payload.get("flush") == True
    mode = str(payload.get("mode") or "fast").strip().lower()
    if mode != "slow":
        mode = "fast"
    # end if
    room = ""
    if payload.get("room"):
        room = sanitize.clean_html(str(payload.get("room")).strip().upper())[0:12]
    # end if
    source = sanitize.clean_html(str(payload.get("source") or ""))[0:40]
    seq_raw = str(payload.get("seq") or "")
    seq = int(seq_raw) if seq_raw.isdigit() else None
    canvas_objects = payload.get("canvas_objects")
    if not isinstance(canvas_objects, list):
        canvas_objects = []
    # end if
    clean_canvas = []
    for obj in canvas_objects[0:4]:
        if not isinstance(obj, dict):
            continue
        # end if
        clean_canvas.append({
            "id": sanitize.clean_html(str(obj.get("id") or ""))[0:24],
            "icon": sanitize.clean_html(str(obj.get("icon") or ""))[0:32],
            "label": sanitize.clean_html(str(obj.get("label") or ""))[0:32],
            "highlight_stat": sanitize.clean_html(str(obj.get("highlight_stat") or ""))[0:12] or None
        })
    # end for
    slide = None
    raw_slide = payload.get("slide")
    if isinstance(raw_slide, dict):
        slide = {
            "beat": sanitize.clean_html(str(raw_slide.get("beat") or ""))[0:12],
            "kicker": sanitize.clean_html(str(raw_slide.get("kicker") or ""))[0:24],
            "headline": sanitize.clean_html(str(raw_slide.get("headline") or ""))[0:80]
        }
    # end if

    proc = sketchtalk_proc()
    if room != "":
        proc.set_gen_mode(room, mode)
    # end if
    if transcript == "":
        info = proc.slow_public(room)
        result = {
            "status": "SUCCESS",
            "engine": "command",
            "gen_mode": info["mode"],
            "slow_status": info["status"],
            "directive": {"action": "IGNORE", "topic_summary": "", "layout": "single", "objects": []}
        }
    else:
        result = proc.interpret(transcript, lang, is_paused, clean_canvas, partial, instant, room, source, slide, mode, flush)
    # end if

    # Echo the client sequence number so stale real-time responses can be
    # dropped browser-side while the speaker keeps talking.
    if seq != None:
        result["seq"] = seq
    # end if
    return jsonify(result)
# end def
