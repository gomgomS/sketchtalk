import sys
import traceback

sys.path.append("slapz102_core")
sys.path.append("slapz102_modules")
sys.path.append("slapz102_settings")
sys.path.append("slapz102_stdlib")
sys.path.append("slapz102_storage")

from flask import Blueprint, jsonify, redirect

from view.sketchtalk import view_sketchtalk

# ---------------------------------------------------------------------------
# SKETCHTALK MODULE — route layer.
#
# Routes only: declare, delegate to the view, catch exceptions -> 500.
#
#   GET  /                            home (create / join a room)
#   POST /sketchtalk/new              create a room -> stage
#   GET  /mic?code=ROOM               jump helper -> /mic/<room>
#   GET  /sketchtalk                  stage with a fresh room
#   GET  /sketchtalk/<room>           presentation screen for a room
#   GET  /mic/<room>                  mic-only page for a room
#   POST /sketchtalk/interpret        transcript -> directive (optionally room)
#   GET  /sketchtalk/room/<room>/state  latest directive (screen polling)
# ---------------------------------------------------------------------------

sketchtalk_blueprint = Blueprint("sketchtalk_blueprint", __name__)

@sketchtalk_blueprint.route("/", methods=["GET"])
def home():
    try:
        return view_sketchtalk.html_home()
    except Exception as e:
        print(traceback.format_exc())
        return "An error occurred", 500
    # end try
# end def

@sketchtalk_blueprint.route("/sketchtalk/new", methods=["POST"])
def create_room():
    try:
        return view_sketchtalk.html_create_room()
    except Exception as e:
        print(traceback.format_exc())
        return "An error occurred", 500
    # end try
# end def

@sketchtalk_blueprint.route("/mic", methods=["GET"])
def mic_jump():
    try:
        return view_sketchtalk.html_mic_jump()
    except Exception as e:
        print(traceback.format_exc())
        return "An error occurred", 500
    # end try
# end def

@sketchtalk_blueprint.route("/sketchtalk", methods=["GET"])
def stage_new():
    try:
        return view_sketchtalk.html_stage("")
    except Exception as e:
        print(traceback.format_exc())
        return "An error occurred", 500
    # end try
# end def

@sketchtalk_blueprint.route("/sketchtalk/<room>", methods=["GET"])
def stage(room):
    try:
        return view_sketchtalk.html_stage(room)
    except Exception as e:
        print(traceback.format_exc())
        return "An error occurred", 500
    # end try
# end def

@sketchtalk_blueprint.route("/mic/<room>", methods=["GET"])
def mic(room):
    try:
        return view_sketchtalk.html_mic(room)
    except Exception as e:
        print(traceback.format_exc())
        return "An error occurred", 500
    # end try
# end def

@sketchtalk_blueprint.route("/sketchtalk/room/<room>/state", methods=["GET"])
def room_state(room):
    try:
        return view_sketchtalk.json_room_state(room)
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"status": "ERROR", "desc": "An error occurred"}), 500
    # end try
# end def

@sketchtalk_blueprint.route("/sketchtalk/interpret", methods=["POST"])
def interpret():
    try:
        return view_sketchtalk.json_interpret()
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"status": "ERROR", "desc": "An error occurred"}), 500
    # end try
# end def
