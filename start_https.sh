#!/usr/bin/env bash
# Run the SketchTalk dev server with HTTPS so microphone capture is
# allowed on OTHER devices (phones / second laptops over the LAN).
#
# Prerequisite: bash make_cert.sh
export FLASK_APP=server.py
export FLASK_ENV=development
export LC_ALL=en_US.utf8
export LANG=en_US.utf8
export SKETCHTALK_TLS_CERT="${SKETCHTALK_TLS_CERT:-tls/sketchtalk-cert.pem}"
export SKETCHTALK_TLS_KEY="${SKETCHTALK_TLS_KEY:-tls/sketchtalk-key.pem}"
export PORT="${PORT:-5004}"

if [ ! -f "$SKETCHTALK_TLS_CERT" ]; then
    echo "No certificate at $SKETCHTALK_TLS_CERT — run: bash make_cert.sh"
    exit 1
fi

exec venv/bin/python server.py
