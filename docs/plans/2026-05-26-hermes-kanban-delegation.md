# AgentControl Hermes Kanban delegation integration

## Goal
When an AgentControl subtask is delegated, it must be backed by a real Hermes Kanban task. AgentControl must show the delegated profile, Hermes Kanban status, Hermes task id, and real Kanban events/log content in the subtask detail view, while preserving the existing AgentControl chat run behavior.

## Current state
- AgentControl already creates internal subtasks as real AgentControl `tasks` with `parent_task_id`.
- `POST /api/tasks/:id/subtasks` can start a delegated chat run via `startTaskChatRun(subtask, ...)`.
- This does not yet expose a real Hermes Kanban task/log stream in the AgentControl API/UI.
- Hermes Kanban source of truth lives in `~/.hermes/kanban.db` and/or `hermes kanban` CLI.

## Acceptance criteria
1. Delegated subtask creation creates or links a real Hermes Kanban task.
2. Stable mapping exists between AgentControl task id and Hermes Kanban task id. Prefer using AgentControl task id when supported; otherwise persist a mapping without fragile title matching.
3. Delegation profile is stored/displayed in AgentControl. If no new DB column is added, use `assignee` deliberately as the profile source and document it.
4. Backend API exposes real Hermes Kanban metadata and logs, for example:
   - `GET /api/tasks/:id/kanban`
   - `GET /api/tasks/:id/kanban/logs`
5. API responses are grounded in Hermes Kanban DB/CLI events, not fabricated from AgentControl fields.
6. Subtask detail UI shows profile, Hermes status/id, and a compact Kanban log panel next to/under the normal chat history.
7. Verification creates a real parent + delegated subtask and proves both AgentControl DB/API and Hermes Kanban logs contain real content.

## Important files
- `server/routes/tasks.ts`
- `server/db/queries.ts`
- `server/db/index.ts`
- `server/db/schema.sql`
- `server/paths.ts`
- `server/app.ts`
- `client/src/lib/api.ts`
- `client/src/components/TaskDetailPage.tsx`
- `shared/types.ts`
- Hermes Kanban reference: `/Users/renatowasescha/.hermes/hermes-agent/hermes_cli/kanban_db.py`

## Verification commands
Run from `/Users/renatowasescha/GIT/jarvis-mission-control-agentcontrol-kanban-delegation` or the task worktree.

```bash
npm run build:server
npm run build:client
npm run build
```

For API/UI smoke, start a tracked local AgentControl server on a free port or the default port if available, then:

```bash
curl -fsS http://127.0.0.1:7460/api/health
curl -fsS http://127.0.0.1:7460/api/tasks/<parentId>/subtasks
curl -fsS http://127.0.0.1:7460/api/tasks/<subtaskId>/kanban
curl -fsS http://127.0.0.1:7460/api/tasks/<subtaskId>/kanban/logs
hermes kanban --board jarvis-mission-control show <kanbanTaskId>
hermes kanban --board jarvis-mission-control log <kanbanTaskId>
```

## Delivery expectation
One coherent feature branch/PR for this topic. Include exact test task ids, subtask id, Kanban task id, endpoint output excerpts, build results, and PR URL in the final Kanban comments.
