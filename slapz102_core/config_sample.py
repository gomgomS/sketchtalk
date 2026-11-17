import os

# ---------------------------------------------------------------------------
# Framework configuration — SAMPLE FILE (committed).
#
# Copy it to start a project:
#     cp slapz102_core/config_sample.py slapz102_core/config.py
#
# config.py is gitignored: unique values (secret key, DB name, public URL)
# live only in your local config.py and never reach the repository.
#
# Usage in modules:  from slapz102_core import config  ->  config.mainDB
# ---------------------------------------------------------------------------

# Flask session signing secret — REPLACE with your own unique value:
#     python3 -c "import os; print(os.urandom(24).hex())"
# The server refuses to start outside development mode while this is unchanged.
G_FLASK_SECRET = os.environ.get("FLASK_SECRET_KEY", "CHANGE-ME-BEFORE-DEPLOY")

# Repo root, independent of the folder the server is launched from
G_HOME_PATH = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
G_STATIC_URL_PATH = "/static"
G_UPLOAD_PATH = G_HOME_PATH + G_STATIC_URL_PATH + "/upload"
G_UPLOAD_URL_PATH = G_STATIC_URL_PATH + "/upload"

# Public URL of the deployed site (no trailing slash). Used to build absolute
# URLs for Open Graph / share previews.
G_PUBLIC_SITE_URL = os.environ.get("PUBLIC_SITE_URL", "http://localhost:5004").strip().rstrip("/")

# Display name used by the sample module's templates
G_SITE_NAME = os.environ.get("SITE_NAME", "SLAPZ Boilerplate")

# Default social-share / Open Graph image (relative to /static)
G_OG_IMAGE_PATH = G_STATIC_URL_PATH + "/brand/og-default.jpg"

# DATABASE ---------------------------------------------------------------
# MongoDB connection. Override MONGO_URI / MONGO_DB_NAME per environment.
mainDB = os.environ.get("MONGO_DB_NAME", "slapz")
mainDB_string = os.environ.get(
    "MONGO_URI", "mongodb://127.0.0.1:27017/"
).rstrip("/") + "/" + mainDB

G_DATABASE_CONNECT = [
    {"dbname": mainDB, "dbstring": mainDB_string}
]

# Offset in hours added to UTC when building rec_timestamp fields
JKTA_TZ = int(os.environ.get("TZ_OFFSET_HOURS", "7"))

# SKETCHTALK --------------------------------------------------------------
# Visual Director LLM provider. Auto order: deepseek -> anthropic -> offline.
# Force with SKETCHTALK_PROVIDER=deepseek|anthropic|off.
G_SKETCHTALK_PROVIDER = os.environ.get("SKETCHTALK_PROVIDER", "auto").strip().lower()

# DeepSeek (OpenAI-compatible API, https://api.deepseek.com).
G_DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "").strip()
G_SKETCHTALK_DS_MODEL = os.environ.get("SKETCHTALK_DS_MODEL", "deepseek-chat").strip()

# Anthropic API key for the SketchTalk Visual Director. When empty, the
# module falls back to the built-in offline keyword parser (demo mode).
G_ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()

# Model used by the Visual Director (any current Messages API model id).
G_SKETCHTALK_MODEL = os.environ.get("SKETCHTALK_MODEL", "claude-opus-5-5").strip()
