#!/usr/bin/env bash
# Generate a self-signed TLS certificate so the mic page works on OTHER
# devices (browsers only allow microphone access over https:// or on
# localhost). The LAN IPs are added as SANs; add more if needed.
#
#   bash make_cert.sh
#
# Then start the server with HTTPS:
#   bash start_https.sh
set -e

CERT_DIR="${1:-tls}"
mkdir -p "$CERT_DIR"

LAN_IPS=$(hostname -I 2>/dev/null || echo "")
SAN="DNS:localhost"
for ip in $LAN_IPS; do
    SAN="$SAN,IP:$ip"
done

openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
    -keyout "$CERT_DIR/sketchtalk-key.pem" \
    -out "$CERT_DIR/sketchtalk-cert.pem" \
    -subj "/CN=sketchtalk.local" \
    -addext "subjectAltName=$SAN" \
    -addext "basicConstraints=CA:FALSE" \
    -addext "keyUsage=digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth"

echo ""
echo "Certificate written to $CERT_DIR/"
echo "SANs: $SAN"
echo ""
echo "Next: bash start_https.sh   (then open https://<LAN-IP>:5004 on the"
echo "other device, accept the self-signed warning once, and the mic will"
echo "be allowed)."
