# Kanban Sync + GitHub Status QA Proof

Date: 2026-05-27
Branch: `kanban/ac-kanban-sync-qa-proof`

## Scope

Verified that AgentControl can import external Hermes Kanban children as real
AgentControl subtasks and expose real Kanban status/log content through the task
API. The QA branch also resolves the integration merge between the Kanban sync,
GitHub status, webhook, and UI PR lines.

## Verification

### Build

Command:

```bash
npm run build
```

Result: passed.

### Isolated AgentControl smoke

Command:

```bash
node /tmp/qa_smoke_import.mjs
```

The first attempt exposed a local native module mismatch for `better-sqlite3`
after switching Node versions; `npm rebuild better-sqlite3` fixed it. The second
attempt using the app import server completed the API verification and printed:

```json
{
  "ok": true,
  "healthOk": true,
  "parentKanbanId": "t_573b8e90",
  "syncImported": 2,
  "syncUpdated": 0,
  "subtaskCount": 2,
  "sampleKanbanId": "t_e2d3fb80",
  "kanbanStatus": "ready",
  "runs": 1,
  "events": 28,
  "comments": 3
}
```

The harness starts AgentControl with an isolated `AGENTCONTROL_HOME` under `/tmp`,
creates an AgentControl parent task, maps it to real Hermes Kanban task
`t_573b8e90`, calls `POST /api/tasks/:id/kanban/sync`, then verifies:

- `GET /api/tasks/:id/subtasks` returns imported subtasks.
- Imported subtasks contain `hermes_kanban_task_id`.
- `GET /api/tasks/:subtaskId/kanban` returns real Kanban info.
- `GET /api/tasks/:subtaskId/kanban/logs` returns real run/event/comment arrays.

### Real Kanban evidence

Sample imported child:

- AgentControl subtask: generated during smoke
- Hermes Kanban task: `t_e2d3fb80`
- Status from Kanban: `ready`
- Real logs visible: 1 run, 28 events, 3 comments

## Notes

- The canonical QA smoke parent used `t_573b8e90` because it has real linked
  children (`t_e2d3fb80`, `t_53104a97`) in the local Hermes Kanban DB.
- The original high-level parent `t_139bd35b` exists, but has no direct
  `task_links` rows in the current board DB, so it is not suitable as the smoke
  parent for endpoint proof.
- The standalone `node dist/server/server/index.js` smoke hit a known frontend
  mount path problem in the built artifact; importing `dist/server/server/app.js`
  gives the same API surface without mounting Vite/frontend dev middleware and
  is sufficient for API proof.
