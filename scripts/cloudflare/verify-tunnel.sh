#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/cloudflare/verify-tunnel.sh <hostname>

Environment:
  HOST                Local bind host to probe (default: 127.0.0.1)
  PORT                Local port to probe (default: 6969)
  CLOUDFLARED_CONFIG  cloudflared config path (default: ~/.cloudflared/config.yml)

Checks local /api/health, cloudflared ingress validation/rule matching when
cloudflared is installed, and the public Cloudflare Access response headers.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

HOSTNAME="${1:-}"
if [[ -z "$HOSTNAME" ]]; then
  usage >&2
  exit 64
fi

LOCAL_HOST="${HOST:-127.0.0.1}"
LOCAL_PORT="${PORT:-6969}"
CLOUDFLARED_CONFIG="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
LOCAL_URL="http://${LOCAL_HOST}:${LOCAL_PORT}/api/health"
PUBLIC_URL="https://${HOSTNAME}/api/health"

info() { printf '[info] %s\n' "$*"; }
ok() { printf '[ok] %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*" >&2; }
fail() { printf '[fail] %s\n' "$*" >&2; exit 1; }

info "checking local health: ${LOCAL_URL}"
local_body="$(mktemp)"
local_code="$(curl -sS -o "$local_body" -w '%{http_code}' "$LOCAL_URL" || true)"
if [[ "$local_code" != "200" ]]; then
  cat "$local_body" >&2 || true
  rm -f "$local_body"
  fail "local health returned HTTP ${local_code}; start Jarvis Mission Control on ${LOCAL_HOST}:${LOCAL_PORT} first"
fi
ok "local health returned HTTP 200: $(tr -d '\n' < "$local_body" | cut -c1-160)"
rm -f "$local_body"

if command -v cloudflared >/dev/null 2>&1; then
  if [[ -f "$CLOUDFLARED_CONFIG" ]]; then
    info "validating cloudflared config: ${CLOUDFLARED_CONFIG}"
    cloudflared tunnel --config "$CLOUDFLARED_CONFIG" ingress validate >/dev/null
    ok "cloudflared ingress config is valid"

    info "checking ingress rule match for https://${HOSTNAME}"
    rule_output="$(cloudflared tunnel ingress rule "https://${HOSTNAME}" --config "$CLOUDFLARED_CONFIG")"
    printf '%s\n' "$rule_output"
    if ! grep -Fq "$HOSTNAME" <<<"$rule_output"; then
      fail "ingress rule output does not mention ${HOSTNAME}; check rule order and hostname"
    fi
    expected_service="http://${LOCAL_HOST}:${LOCAL_PORT}"
    if grep -Fq 'http_status:404' <<<"$rule_output"; then
      fail "ingress matched fallback 404 rule; move hostname rule above the fallback"
    fi
    if ! grep -Fq "$expected_service" <<<"$rule_output"; then
      warn "ingress rule did not show expected service ${expected_service}; verify this is intentional"
    else
      ok "ingress rule targets ${expected_service}"
    fi
  else
    warn "cloudflared config not found at ${CLOUDFLARED_CONFIG}; skipping ingress validation"
  fi
else
  warn "cloudflared command not found; skipping ingress validation"
fi

headers="$(mktemp)"
info "checking public Access response: ${PUBLIC_URL}"
public_code="$(curl -sS -D "$headers" -o /dev/null -w '%{http_code}' "$PUBLIC_URL" || true)"
printf '%s\n' '--- public response headers ---'
grep -Ei '^(HTTP/|location:|www-authenticate:|cf-ray:|server:|cf-cache-status:)' "$headers" || true
printf '%s\n' '-------------------------------'

if [[ "$public_code" == "000" ]]; then
  rm -f "$headers"
  fail "public URL was unreachable"
fi

if [[ "$public_code" == "200" ]]; then
  warn "public health returned HTTP 200. This is only acceptable if Cloudflare Access is intentionally disabled."
elif [[ "$public_code" =~ ^(302|401|403)$ ]] && grep -Eiq '(cloudflare-access|/cdn-cgi/access/login|cloudflareaccess\.com)' "$headers"; then
  ok "public endpoint is protected by Cloudflare Access (HTTP ${public_code})"
elif [[ "$public_code" =~ ^(301|302|303|307|308)$ ]]; then
  ok "public endpoint redirects (HTTP ${public_code}); inspect Location above for Access login"
else
  warn "public endpoint returned HTTP ${public_code}; inspect headers above"
fi

rm -f "$headers"
ok "verification complete for ${HOSTNAME}"
