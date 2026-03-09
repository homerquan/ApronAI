#!/usr/bin/env bash
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSL_DIR="${SERVER_DIR}/ssl"
CERT_FILE="${SSL_DIR}/cert.pem"
KEY_FILE="${SSL_DIR}/key.pem"

mkdir -p "${SSL_DIR}"

ips=("127.0.0.1" "0.0.0.0")

# Auto-detect common macOS LAN interfaces.
if command -v ipconfig >/dev/null 2>&1; then
  for iface in en0 en1; do
    ip="$(ipconfig getifaddr "${iface}" 2>/dev/null || true)"
    if [[ -n "${ip}" ]]; then
      ips+=("${ip}")
    fi
  done
fi

# Allow manual extra IPs: ./scripts/generate_dev_cert.sh 192.168.1.20
if [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    ips+=("${arg}")
  done
fi

# Deduplicate while preserving order.
deduped=()
for ip in "${ips[@]}"; do
  skip=false
  for seen in "${deduped[@]:-}"; do
    if [[ "${seen}" == "${ip}" ]]; then
      skip=true
      break
    fi
  done
  if [[ "${skip}" == false ]]; then
    deduped+=("${ip}")
  fi
done

san="DNS:localhost"
for ip in "${deduped[@]}"; do
  san="${san},IP:${ip}"
done

openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
  -keyout "${KEY_FILE}" \
  -out "${CERT_FILE}" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=${san}" >/dev/null 2>&1

echo "Generated:"
echo "  ${CERT_FILE}"
echo "  ${KEY_FILE}"
echo "SAN: ${san}"
