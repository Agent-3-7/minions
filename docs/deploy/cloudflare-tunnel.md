# Cloudflare Tunnel deployment

This runbook exposes Jarvis Mission Control through an existing Cloudflare Tunnel while keeping the Node service loopback-only.

## Target topology

```text
browser -> https://<hostname> -> Cloudflare Zero Trust Access -> Cloudflare Tunnel -> http://127.0.0.1:6969
```

Default local origin:

```bash
HOST=127.0.0.1
PORT=6969
MINIONS_HOME=~/.minions
HERMES_AGENT_DIR=~/.hermes/hermes-agent
```

Do not bind Jarvis Mission Control to `0.0.0.0` for tunnel deployments. Cloudflared can reach `127.0.0.1` directly, and loopback binding prevents accidental LAN exposure.

## 1. Build and start the local service

Install dependencies once, then build:

```bash
npm install
npm run build
```

For a foreground smoke test:

```bash
HOST=127.0.0.1 PORT=6969 npm run start
```

For a persistent local service, use the PM2 example in `scripts/pm2/jarvis-mission-control.ecosystem.config.cjs`:

```bash
pm2 start scripts/pm2/jarvis-mission-control.ecosystem.config.cjs --only jarvis-mission-control
pm2 save
pm2 status jarvis-mission-control
```

Local health must return `200` before changing Cloudflare:

```bash
curl -fsS http://127.0.0.1:6969/api/health
```

Expected shape:

```json
{"ok":true,"hermes":true}
```

`hermes` may be `false` if the local Hermes worker is not configured yet, but the HTTP service is healthy when curl exits with status 0.

## 2. Add a Cloudflare Tunnel ingress rule

Edit the existing cloudflared config, usually `~/.cloudflared/config.yml`, and insert the hostname rule above the final fallback:

```yaml
ingress:
  - hostname: ms.selly.dev
    service: http://127.0.0.1:6969

  # keep existing host rules here

  - service: http_status:404
```

Validate the config:

```bash
cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
cloudflared tunnel ingress rule https://ms.selly.dev --config ~/.cloudflared/config.yml
```

The rule lookup must show the requested hostname and `service: http://127.0.0.1:6969`.

## 3. Route DNS to the tunnel

Only run this after the hostname is approved for external DNS:

```bash
cloudflared tunnel list
cloudflared tunnel route dns <tunnel-name-or-id> ms.selly.dev
```

Cloudflare may answer with proxied A/AAAA edge IPs instead of an obvious CNAME. That is normal for proxied tunnel hostnames.

## 4. Protect the hostname with Cloudflare Access

Create or reuse a Cloudflare Zero Trust Access application for the hostname.

Minimum expectation:

- Public unauthenticated `https://ms.selly.dev/api/health` does not return the app JSON.
- It returns a Cloudflare Access challenge, usually `302` to `/cdn-cgi/access/login/...` or a `WWW-Authenticate: Cloudflare-Access` header.
- Authenticated users can reach the dashboard after Access login.

Unauthenticated verification:

```bash
curl -sS -D- -o /dev/null https://ms.selly.dev/api/health | grep -Ei 'HTTP/|location:|www-authenticate:|cf-ray:'
```

Acceptable protected output includes one of:

```text
HTTP/2 302
location: https://<team>.cloudflareaccess.com/cdn-cgi/access/login/...
```

or:

```text
www-authenticate: Cloudflare-Access
```

If this returns `HTTP/2 200` and the JSON body without a login session, Access is not protecting the app.

## 5. Restart cloudflared

On macOS LaunchAgent installs:

```bash
launchctl kickstart -k gui/$(id -u)/com.cloudflare.cloudflared
```

If cloudflared is supervised another way, restart that supervisor instead. Then check the tunnel is connected:

```bash
cloudflared tunnel info <tunnel-name-or-id>
```

## 6. End-to-end verification

Use the bundled script:

```bash
scripts/cloudflare/verify-tunnel.sh ms.selly.dev
```

With a non-default origin port or config file:

```bash
PORT=6969 HOST=127.0.0.1 CLOUDFLARED_CONFIG=~/.cloudflared/config.yml scripts/cloudflare/verify-tunnel.sh ms.selly.dev
```

The script checks:

1. Local `/api/health` responds successfully.
2. `cloudflared tunnel --config ... ingress validate` passes, when cloudflared is installed.
3. `cloudflared tunnel ingress rule https://<hostname> --config ...` selects the hostname rule.
4. Public `/api/health` returns either a Cloudflare Access challenge (`302`/`401`/`403` with Access headers) or, if Access is intentionally disabled, warns about a public `200`.

## Troubleshooting

### Public 502 from Cloudflare

First prove the origin is listening:

```bash
lsof -nP -iTCP:6969 -sTCP:LISTEN || true
curl -fsS http://127.0.0.1:6969/api/health
```

If local curl fails, restart the PM2 service before debugging WAF or Access:

```bash
pm2 restart jarvis-mission-control --update-env
pm2 logs jarvis-mission-control --lines 80
```

### Rule lookup matches the fallback

Move the hostname rule above `- service: http_status:404` and above any broader wildcard rules, then restart cloudflared.

### iOS Safari shows stale data through the tunnel

This is usually SSE reconnection behavior after iOS backgrounds the tab or after the Cloudflare Access cookie expires. Verify the local event stream first:

```bash
curl -sS -D- http://127.0.0.1:6969/api/events --max-time 3 | head -20
```

Then re-authenticate through Access in Safari and hard-refresh the dashboard.
