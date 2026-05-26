# QA Acceptance Checklist — Jarvis Mission Control

Verified on: 2026-05-26 12:32 CEST
Branch: `kanban/jmc-jarvis-cards`
Repository: `rewasa/jarvis-mission-control`
Local path: `/Users/renatowasescha/GIT/jarvis-mission-control`

## Summary

The consolidated Jarvis Mission Control branch passes build and local API smoke verification. Cloudflare Tunnel routing is configured and protected by Cloudflare Access. iOS compatibility has code-level and production-build evidence; final physical-device Safari execution remains a manual acceptance step.

## Acceptance Criteria

| Criterion | Status | Evidence |
|---|---:|---|
| Repo forked and available | ✅ Verified | `origin=https://github.com/rewasa/jarvis-mission-control.git`, `upstream=https://github.com/Agent-3-7/minions.git` |
| Git repository maintained | ✅ Verified | Active branch `kanban/jmc-jarvis-cards`; dirty state contains only QA/report + schema conflict-resolution work before final commit |
| Cloudflare Tunnel works | ✅ Verified | `cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate` → `OK`; `cloudflared tunnel ingress rule https://ms.selly.dev` matched rule #0 → `service: http://127.0.0.1:6969` |
| Cloudflare Access protects public app | ✅ Verified | `curl -D- https://ms.selly.dev/api/health` returned `HTTP/2 302`, `location: https://dev-agentselly.cloudflareaccess.com/cdn-cgi/access/login/...`, `www-authenticate: Cloudflare-Access`, `cf-ray: ...-ZRH` |
| iOS compatibility implemented | ✅ Code/build verified | Production dist contains `viewport-fit=cover`, `safe-area-inset-*`, `h-dvh`, `touch-action: manipulation`, `-webkit-text-size-adjust:100%`, and `visibilitychange` refresh handling |
| iOS test on physical device | ⚠️ Manual pending | Checklist exists in `docs/qa/ios-smoke-test.md`; requires actual iPhone/iPad Safari through the tunnel |
| Kanban View with Jarvis Cards visible | ✅ Build verified | `client/src/components/Column.tsx` renders `JarvisCard`; `Board.tsx` renders `JarvisCardOverlay`; production build succeeded |
| Subtasks as subissues delegable | ✅ API smoke verified | Created parent task and delegated subissue through `/api/tasks/:id/subissues`; response had `parent_task_id`, `delegation_status: "queued"`, `assignee: "qa-dev"`, labels, priority, and parent `child_count: 1` |
| Hermes integration intact | ✅ Local health verified | Local `/api/health` returned `{ "ok": true, "hermes": true }` during smoke run with `HERMES_WORKER_DISABLED=1` |

## Commands Executed

### Build

```bash
cd /Users/renatowasescha/GIT/jarvis-mission-control
npm run build
```

Result: ✅ exit code 0.

### Local smoke server

```bash
rm -f /tmp/jmc-smoke.sqlite /tmp/jmc-smoke.sqlite-*
PORT=45138 HOST=127.0.0.1 MINIONS_DB_PATH=/tmp/jmc-smoke.sqlite HERMES_WORKER_DISABLED=1 \
  node dist/server/server/index.js
```

Result: ✅ server stayed running on `127.0.0.1:45138` for smoke tests.

### Health

```bash
curl -fsS http://127.0.0.1:45138/api/health | python3 -m json.tool
```

Result:

```json
{
  "ok": true,
  "hermes": true
}
```

### Subissue delegation smoke

Parent creation:

```bash
curl -fsS -X POST http://127.0.0.1:45138/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"QA parent for Jarvis Mission Control","description":"Parent task created by final QA smoke test"}'
```

Parent id observed: `bdb5dd3f-24a0-452b-93a1-af8466c7556c`.

Delegated subissue creation:

```bash
curl -fsS -X POST http://127.0.0.1:45138/api/tasks/bdb5dd3f-24a0-452b-93a1-af8466c7556c/subissues \
  -H 'Content-Type: application/json' \
  -d '{"title":"Delegated smoke subissue","description":"Verify delegated subissue payload","delegate":true,"priority":5,"labels":["qa","ios","cloudflare"],"assignee":"qa-dev","agent_model":"deepseek-v4-flash","reasoning_effort":"medium"}'
```

Observed child id: `2bf96a2d-cf12-4300-ac0d-4497d564f4f9`.

Verified assertions:

- `subissues.length === 1`
- `subissues[0].parent_task_id === parent.id`
- `subissues[0].delegation_status === "queued"`
- `subissues[0].assignee === "qa-dev"`
- child description includes `Created from parent task`
- parent response includes `child_count: 1`
- `/api/tasks` returned at least one parent with `child_count > 0` and at least one child with `parent_task_id`

### Cloudflare Tunnel and Access verification

```bash
cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate
cloudflared tunnel ingress rule https://ms.selly.dev --config ~/.cloudflared/config.yml
curl -sS -D- -o /dev/null --max-time 15 https://ms.selly.dev/api/health | grep -Ei 'HTTP/|location:|www-authenticate:|cf-ray:|server:'
```

Observed:

```text
Validating rules from /Users/renatowasescha/.cloudflared/config.yml
OK
Using rules from /Users/renatowasescha/.cloudflared/config.yml
Matched rule #0
	hostname: ms.selly.dev
	service: http://127.0.0.1:6969
HTTP/2 302
location: https://dev-agentselly.cloudflareaccess.com/cdn-cgi/access/login/ms.selly.dev?...&redirect_url=%2Fapi%2Fhealth
www-authenticate: Cloudflare-Access resource_metadata="https://ms.selly.dev/.well-known/cloudflare-access-protected-resource/api/health"
server: cloudflare
cf-ray: a01c1c207e62931a-ZRH
```

## Evidence Files

- Cloudflare runbook: `docs/deploy/cloudflare-tunnel.md`
- Cloudflare verification script: `scripts/cloudflare/verify-tunnel.sh`
- PM2 production example: `scripts/pm2/jarvis-mission-control.ecosystem.config.cjs`
- iOS manual smoke checklist: `docs/qa/ios-smoke-test.md`
- Implementation plan and acceptance criteria: `docs/plans/2026-05-26-jarvis-mission-control.md`

## Remaining Manual Gate

Physical iOS Safari smoke is still manual: open `https://ms.selly.dev` on an iPhone/iPad, authenticate through Cloudflare Access, and run `docs/qa/ios-smoke-test.md`. Code/build evidence is green, but the measurable criterion “iOS-Test auf Gerät erfolgreich” should only be marked fully complete after a real device run.
