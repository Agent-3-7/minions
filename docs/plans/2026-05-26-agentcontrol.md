# AgentControl Implementation Plan

> **For Hermes:** Use Kanban task delegation for implementation. Code tasks must run in isolated git worktrees from `/Users/renatowasescha/GIT/jarvis-mission-control` and land in Git with commits/PRs. One PR per coherent topic.

**Goal:** Fork upstream Minions into **AgentControl**: a Hermes-native mission control dashboard with Cloudflare Tunnel support, iOS-compatible UX/realtime behavior, Linear-style Kanban/AgentControl cards, and delegable subtasks as subissues.

**Repository:** `https://github.com/rewasa/jarvis-mission-control` (fork of `Agent-3-7/minions`)

**Local path:** `/Users/renatowasescha/GIT/jarvis-mission-control`

**Architecture:** Keep the current Express + SQLite + Hermes worker + React/Vite stack. Add a small product identity layer, metadata tables for task hierarchy/delegation, API routes for subissues, UI components for AgentControl cards, mobile/SSE resiliency, and deployment docs/scripts for Cloudflare Tunnel. Do not replace Hermes; integrate deeper by using Hermes session/tooling conventions and explicit delegation prompts.

**Tech Stack:** Node 18+, Express, SQLite/better-sqlite3, React 19, Vite, Tailwind, Zustand, Hermes Agent Python worker, Cloudflare Tunnel/Access.

---

## Current Baseline / Gap Analysis

Already present in the upstream base:
- Express API + React Kanban board on `:7460`.
- SQLite task persistence under `AGENTCONTROL_HOME`.
- Direct Hermes `AIAgent` integration through `server/workers/hermes_worker.py`.
- Hermes scheduled tasks page and skills support.
- SSE board updates via `/api/events` and live chat via `/api/tasks/:id/live`.

Missing for AgentControl:
- Repo/product identity and docs for the fork.
- First-class Cloudflare Tunnel config/runbook and health verification.
- iOS-specific viewport/touch/SSE fallback/reconnect support.
- Task hierarchy: parent/subissue metadata, API routes, event payloads.
- Delegation action: create subissue and optionally start a Hermes goal run with scoped context.
- Linear-style AgentControl cards: richer metadata, child counts, status badges, priority/labels, visual hierarchy.
- Verification scripts and acceptance smoke tests.

---

## Milestone 0 — Fork + Project Setup

**Objective:** Establish the fork as AgentControl and keep upstream sync clean.

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Create: `docs/plans/2026-05-26-agentcontrol.md`
- Create: `docs/operations/upstream-sync.md`

**Steps:**
1. Rename GitHub fork to `rewasa/jarvis-mission-control`.
2. Set local `origin` to the fork and `upstream` to `Agent-3-7/minions`.
3. Add product name/description while keeping package binary compatibility initially (`minions` remains as a backwards-compatible CLI alias).
4. Document sync flow:
   - `git fetch upstream`
   - `git checkout main`
   - `git merge upstream/main`
   - run build
   - push origin main
5. Verify: `git remote -v`, `gh repo view rewasa/jarvis-mission-control`, `npm run build`.

---

## Milestone 1 — Cloudflare Tunnel Support

**Objective:** Make local AgentControl safely reachable through Cloudflare Tunnel, with clear production/dev commands.

**Files:**
- Create: `docs/deploy/cloudflare-tunnel.md`
- Create: `scripts/cloudflare/verify-tunnel.sh`
- Create: `scripts/pm2/agentcontrol.ecosystem.config.cjs`
- Modify: `.env.example`
- Modify: `server/index.ts` or server listen/config module if host/port handling is currently hardcoded.

**Implementation notes:**
- App should stay loopback-bound by default: `HOST=127.0.0.1`, `PORT=7460`.
- Cloudflare ingress example:
  ```yaml
  - hostname: ms.selly.dev
    service: http://127.0.0.1:7460
  - service: http_status:404
  ```
- Include Zero Trust Access expectation: public `/api/health` through tunnel should be `302`/Access challenge when protected; local health should be `200`.
- Add a script that verifies local health, ingress rule match, and public Access response headers.

**Verification:**
- `curl -sS http://127.0.0.1:7460/api/health`
- `cloudflared tunnel --config ~/.cloudflared/config.yml ingress validate`
- `cloudflared tunnel ingress rule https://<hostname> --config ~/.cloudflared/config.yml`
- `scripts/cloudflare/verify-tunnel.sh <hostname>`

---

## Milestone 2 — iOS Compatibility

**Objective:** Make the board usable and fresh on iOS Safari through Cloudflare Access/Tunnel.

**Files:**
- Modify: `client/index.html`
- Modify: `client/src/styles/globals.css`
- Modify: `client/src/hooks/useTasks.ts`
- Modify: `client/src/lib/store.ts` if needed for refetch triggers.
- Create: `client/src/hooks/useVisibilityRefresh.ts`
- Create: `docs/qa/ios-smoke-test.md`

**Implementation notes:**
- Add viewport fit and safe-area support:
  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  ```
- Ensure inputs/buttons are at least 16px on small screens to prevent iOS auto-zoom.
- Improve touch drag/drop ergonomics; add non-drag menu/actions for cards on touch.
- Add SSE recovery:
  - Track board EventSource readyState.
  - On `visibilitychange` to visible, refetch `/api/tasks` immediately.
  - Add polling fallback every ~30s when SSE is closed/erroring.
- Confirm Cloudflare Access redirect cases do not leave the board silently stale.

**Verification:**
- Local browser: background/foreground tab triggers `/api/tasks` refetch.
- iPhone Safari via tunnel: create/move task on desktop, return to iPhone tab, board refreshes within 30s or immediately on foreground.
- No horizontal overflow; safe area works in portrait.

---

## Milestone 3 — Task Hierarchy / Subissues (Backend)

**Objective:** Store parent/child relationships and support subissue creation/delegation.

**Files:**
- Modify: `server/db/schema.sql`
- Modify: `server/db/queries.ts`
- Modify: `shared/types.ts`
- Modify: `server/routes/tasks.ts`
- Create: `server/routes/subissues.ts` or keep nested under tasks router.

**Schema approach:**
- Add nullable `parent_task_id` on `tasks` referencing `tasks(id)`.
- Add metadata columns as needed for Linear-style cards: `priority`, `labels_json`, `assignee`, `delegation_status`.
- Add index: `idx_tasks_parent_task_id`.
- Keep migrations idempotent; existing DBs should upgrade on startup.

**API:**
- `GET /api/tasks/:id/subissues` → children.
- `POST /api/tasks/:id/subissues` with `{ title, description, delegate?: boolean, model?, reasoningEffort? }`.
- `PATCH /api/tasks/:id` accepts supported metadata fields.
- Board events include updated parent/child counts.

**Delegation behavior:**
- Creating a delegated subissue should create a child task with parent context embedded in the description.
- If `delegate=true`, start a Hermes goal/task run for the child or place it into the correct work queue according to current AgentControl execution semantics.
- Parent remains human-controlled; child completion can surface on the parent card but should not auto-mark parent done.

**Verification:**
- Create parent → create two subissues → API returns hierarchy.
- Delete/archive behavior is explicit (do not silently delete children unless confirmed).
- Existing tasks without parent still render.

---

## Milestone 4 — Kanban View with AgentControl Cards (Linear Style)

**Objective:** Replace plain task cards with richer AgentControl cards while preserving fast drag/drop.

**Files:**
- Modify: `client/src/components/Board.tsx`
- Modify: `client/src/components/Column.tsx`
- Modify: `client/src/components/TaskCard.tsx`
- Create: `client/src/components/AgentControlCard.tsx`
- Create: `client/src/components/SubissueList.tsx`
- Modify: `client/src/lib/constants.ts`
- Modify: `client/src/styles/globals.css`

**Card content:**
- Title + concise description.
- Status pill, active run indicator, unseen indicator.
- Child/subissue count and progress (`2/5 done`).
- Labels/priority chips.
- Delegation status (`queued`, `running`, `review`, `blocked`).
- Hover/menu actions: create subissue, delegate subissue, copy link, delete.

**Visual direction:**
- Linear-like density, rounded cards, subtle borders, strong typography.
- “AgentControl” accent for active/delegated cards.
- Mobile: card actions accessible by tap, no hover-only dependency.

**Verification:**
- Board visible with all statuses.
- Cards show child counts for parent tasks.
- Drag/drop still works with overlay.
- Mobile/touch interactions still work.

---

## Milestone 5 — Deep Hermes Integration

**Objective:** Make AgentControl feel like a Hermes control plane, not only a wrapper.

**Files:**
- Modify: `server/prompts/task-agent.ts`
- Modify: `server/adapters/hermes-worker.ts`
- Modify: `server/workers/hermes_worker.py`
- Modify: `server/routes/agent.ts`
- Create: `docs/hermes-integration.md`

**Features:**
- Inject parent/subissue context into Hermes worker prompts.
- Surface Hermes model/provider/session metadata on cards/details.
- Make delegation prompts explicit: worker may do work itself, spawn child sessions, or create Hermes cron jobs; subissues should be natural decomposition targets.
- Add a per-task “delegate as subissue” action that creates a scoped child task instead of burying subtasks in chat text.
- Preserve Hermes SessionDB as transcript source of truth.

**Verification:**
- A delegated subissue receives parent context and can run as an autonomous Hermes task.
- Parent card displays child progress and last Hermes run metadata.
- No breakage of scheduled tasks or skill installation.

---

## Milestone 6 — QA, Device Test, Release Hygiene

**Objective:** Prove the measurable acceptance criteria and keep the repo maintainable.

**Files:**
- Create: `docs/qa/acceptance-checklist.md`
- Create: `.github/workflows/ci.yml` if appropriate.
- Optional: add lightweight API/unit tests if test harness is introduced.

**Checks:**
- `npm install` (if dependencies change).
- `npm run build`.
- Local run: `npm run dev` or PM2 service.
- Health: `/api/health` local 200.
- Tunnel: public Access response / ingress rule verified.
- iOS smoke test completed and documented.
- Kanban cards visible; subissues delegable.
- Git: branch committed, pushed, PR opened.

---

## Kanban Task Graph

Use board: `jarvis-mission-control`.

1. **Setup/Fork + Plan** — done by orchestrator.
2. **Cloudflare Tunnel integration** — assignee: `worker` or `backend-dev`; no parents after setup.
3. **iOS compatibility + SSE fallback** — assignee: `kimi-ui`; parent: setup.
4. **Subissues backend model/API** — assignee: `backend-dev`; parent: setup.
5. **AgentControl Cards + Linear-style Kanban UI** — assignee: `kimi-ui`; parent: Subissues backend.
6. **Deep Hermes delegation flow** — assignee: `backend-dev`; parent: Subissues backend.
7. **QA: build + local + iOS/tunnel smoke** — assignee: `qa-dev`; parents: Cloudflare, iOS, UI, Hermes delegation.
8. **Review + Git hygiene** — assignee: `reviewer`; parent: QA.

---

## Acceptance Criteria

- [x] Fork exists: `rewasa/jarvis-mission-control`.
- [x] Local repo exists: `/Users/renatowasescha/GIT/jarvis-mission-control`.
- [ ] Cloudflare Tunnel works for selected hostname.
- [ ] iOS device test successful.
- [ ] Kanban view shows AgentControl/Linear-style cards.
- [ ] Subtasks are createable as subissues and delegable.
- [ ] Implementation committed and pushed with PR(s).
