# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

AgentControl is an autonomous task management system with a Kanban board UI. Users create tasks via a chat interface; each task is a Hermes agent session that autonomously decides how to execute — doing the work itself, spawning child sessions, or creating Hermes cron jobs shown in AgentControl as Scheduled Tasks. Successful agent runs move tasks to review automatically. The user never talks to child sessions directly; recurring work is managed from the Scheduled Tasks page.

## Prerequisites

- Node.js v18+
- Hermes agent installed with its Python venv (default location: `~/.hermes/hermes-agent/`)

The server spawns a Python worker subprocess that imports Hermes `AIAgent` directly — no `hermes gateway` process or HTTP API is involved. The Python executable is resolved in this order:

1. `HERMES_PYTHON` env var (explicit path)
2. `HERMES_AGENT_DIR/venv/bin/python` (if `HERMES_AGENT_DIR` is set)
3. `~/.hermes/hermes-agent/venv/bin/python` (default)
4. `python3` (system fallback)

## Commands

```bash
npm run dev          # dev mode: tsx watch + Vite dev server on :7460
npm run build        # production build: server (tsc) + client (vite) + copy .sql/.py assets
npm run start        # run compiled production build
npm run prod         # build + run production in one command
```

No test suite or linter is configured.

## Architecture

```
Browser (React/Vite :7460)
  ↕ HTTP + SSE
Express API + Vite middleware (:7460)
  ↕ JSONL over stdin/stdout
Python worker (hermes_worker.py)
  ↕ direct Python import
Hermes AIAgent
```

- **Server** (`server/`): Express + SQLite (better-sqlite3, WAL mode). All timestamps are epoch milliseconds.
- **Python worker** (`server/workers/hermes_worker.py`): JSONL bridge that imports Hermes `AIAgent` directly. Spawned as a subprocess by `HermesWorkerAdapter`, auto-restarts on crash. Manages concurrent agent runs via semaphore (default: 10).
- **Client** (`client/`): React 19 + Vite + Tailwind CSS + Zustand + react-router. `@shared` path alias resolves to `../shared/`.
- **Shared** (`shared/types.ts`): TypeScript types used by both client and server.

### State directory

All persistent state lives under `AGENTCONTROL_HOME` (default: `~/.agentcontrol/`):
- `data/agentcontrol.db` — SQLite database
- `logs/` — log files
- `workspace/` — default working directory for Hermes task artifacts
- `skills/` — installed skills, registered with Hermes via `external_dirs`

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent communication | Python subprocess + JSONL | Imports Hermes AIAgent directly — no HTTP gateway overhead, structured streaming events, per-task model/reasoning control |
| Task execution | Autonomous agent session | Each task IS a Hermes session. The agent decides execution strategy (self, child session, Hermes cron job/scheduled task). Our backend doesn't manage child sessions. |
| Review transition | Successful agent runs move to review | After a chat or goal run completes successfully, the server records the response metadata and moves an `in_progress` task to `in_review` in the same update. No separate completion evaluation runs outside the conversation. |
| Source of truth | Hermes SessionDB for chat history; AgentControl SQLite for task metadata; in-memory LiveChatRun for active streams | Hermes owns all transcripts and replay. AgentControl has no message table. `tasks.id` is the Hermes root session ID; AgentControl stores task metadata, per-task settings, and `last_agent_response_at`. During active streaming, `live-chat.ts` holds an in-memory `LiveChatRun` with accumulated messages. After streaming ends and the run TTL expires, chat history is projected from Hermes SessionDB on demand. |
| Status ownership | Successful runs auto-move to `in_review`; human moves everything else via drag-drop | Clean separation: the system queues completed agent work for review, and humans control final completion. |

## Key Patterns

- **Session lifecycle**: `tasks.id` is the AgentControl task ID and the Hermes root session ID. Chat and history reads all use `task.id`; AgentControl does not persist Hermes-returned child or continuation session IDs.
- **Chat projection**: `GET /tasks/:id/messages` loads raw rows from Hermes `SessionDB.get_messages()` via the Python worker, which filters out tool-call-only turns and empty messages. The client shows optimistic messages during streaming and loads the projected history from Hermes on page load/task switch.
- **Review transition**: After each successful chat or goal run, `recordCompletedAgentRun()` records `last_agent_response_at` and context usage. If the task is still `in_progress`, the same update moves it to `in_review` and broadcasts the change.
- **Agent defaults**: Global default model/reasoning settings are stored in the Python worker via `settings.set` and surfaced through `GET /api/agent/defaults`. The Settings page lets users pick the default model (two-panel picker with search) and reasoning effort for all new tasks. Agent settings routes live in `server/routes/agent.ts`.
- **Per-task model/reasoning**: Each task can override the default Hermes model and reasoning effort (`agent_model`, `reasoning_effort` columns on `tasks`). Settings logic lives in `server/agent-settings.ts`. The Python worker resolves the final model/provider from Hermes config + per-task overrides.
- **Live chat**: `POST /api/tasks/:id/messages` returns `202` immediately with a `runId`. The server consumes the agent stream in the background via `consumeChatRun()` in `server/routes/chat.ts`. Clients subscribe to `GET /api/tasks/:id/live` SSE for real-time `text_delta`, `thinking_delta`, `tool_progress`, `done`, and `error` events. On connect, the client receives a snapshot of the current in-memory `LiveChatRun` if one exists. Runs are kept in memory briefly after completion (30s normal, 5min on error) so late-connecting clients can catch up.
- **Live-chat state** (`server/live-chat.ts`): In-memory `Map<taskId, LiveChatRun>` accumulates streaming events into structured messages (user + assistant with tools/thinking/usage). This is ephemeral — on server restart, active run state is lost, but the Hermes session history remains in SessionDB.
- **SSE board events**: `/api/events` broadcasts board-level events (task CRUD) to all clients. Separate from per-task live chat SSE.
- **Disconnect resilience**: If the browser disconnects during a stream, the server continues draining the worker stream to completion. On successful completion, `last_agent_response_at` is recorded for the task.
- **Scheduled Tasks**: Hermes manages the underlying cron job state internally. AgentControl exposes `/api/scheduled-tasks` endpoints to list, create, edit, pause, resume, trigger, remove, and read local output files. Scheduled tasks are standalone; AgentControl no longer links them to task IDs.
- **File browser**: `server/routes/files.ts` exposes CRUD operations on the `AGENTCONTROL_HOME/workspace/` directory (list, read, write, create, rename, delete, upload via multer). The client's `FileBrowserPage` provides a full file manager UI.
- **Skills**: `server/routes/skills.ts` backs the client's `SkillsPage`. Skills install under `AGENTCONTROL_HOME/skills/`, and that directory is registered as a Hermes `external_dirs` entry in `~/.hermes/config.yaml` (edited via the `yaml` library, idempotently) so agent runs load them. Two install sources: the ClawHub registry (`POST /skills/install` by slug — downloads files, verifies SHA-256 checksums, writes a `.agentcontrol-skill.json` sidecar with provider/version/source metadata) and local folder/`.zip` import (`POST /skills/import`, multipart via multer). ClawHub browsing is server-proxied through `GET /skills/registry/{search,browse,:slug/content,:slug/scan}` — the client never calls `clawhub.ai` directly. Other endpoints: `GET /skills` (list installed), `GET /skills/:id/content`, `DELETE /skills/:id`. Skills are pure Node + filesystem + HTTP — they do not go through the Python worker.
- **Server imports**: Use `.js` extensions in import paths (ESM with tsx).

## Task State Machine

```
               user creates
                    │
                    ▼
            ┌──────────────┐
  ┌─────────│  IN_PROGRESS  │◄─────────┐
  │         └───────┬───────┘          │
  │                 │                  │
  │   successful    │                  │ human moves
  │   agent run     │                  │ (drag-drop)
  │                 │                  │
  │          ┌──────▼──────┐           │
  │          │  IN_REVIEW   │          │
  │          │  human       │          │
  │          │  verifies    │──────────┘
  │          └──────┬───────┘
  │                 │
  │                 │ human moves
  │                 │
  │          ┌──────▼──────┐
  └─────────►│    DONE      │
    human    │  verified    │
    moves    └─────────────┘
```

**System moves to**: `in_review` (after successful agent runs)
**Human moves to**: `in_progress`, `done` (via drag-and-drop or action buttons)

## Data Flows

### New Task → Agent Session

```
User creates task via UI
  → POST /api/tasks (creates task in SQLite; tasks.id is the Hermes root session ID)
  → Task appears on board in "In Progress" column
  → User sends first message via POST /api/tasks/:id/messages
  → Server returns 202 with runId; client subscribes to GET /tasks/:id/live SSE
  → Server calls consumeChatRun() with session ID equal to task.id
  → LiveChatRun accumulates text_delta/thinking/tools into in-memory messages
  → Each event is broadcast to /live SSE subscribers in real time
  → Python worker loads prior Hermes history, runs AIAgent.run_conversation()
  → Hermes persists the full turn (user + assistant) in SessionDB
  → Successful completion records tasks.last_agent_response_at and moves task to review
  → Run state expires from memory after TTL; history loads from Hermes on next page load
```

### Completion To Review

```
Chat stream completes (done event in consumeChatRun)
  → recordCompletedAgentRun() records response timestamp and context usage
  → IF task.status === 'in_progress':
      → Update task status to 'in_review' in the same write
  → Broadcast task_updated event
```

## Worker Protocol

The Python worker communicates via JSONL (one JSON object per line) over stdin/stdout.

**Request types**: `health`, `chat`, `session.messages.get`, `session.get`, `goal.status`, `goal.set`, `goal.pause`, `goal.resume`, `goal.clear`, `goal.evaluate`, `settings.get`, `settings.set`, `models.list`, `title.generate`, `session.compress`, `scheduledTasks.list`, `scheduledTasks.get`, `scheduledTasks.create`, `scheduledTasks.update`, `scheduledTasks.pause`, `scheduledTasks.resume`, `scheduledTasks.run`, `scheduledTasks.remove`, `scheduledTasks.tick`

**Stream events** (emitted during `chat` requests):

| Event | Description |
|-------|-------------|
| `text_delta` | Agent's visible response text |
| `thinking_delta` | Agent's reasoning content |
| `tool_progress` | Tool lifecycle (`running` / `completed` / `error`) with name and duration |
| `done` | Stream complete — carries `sessionId` and `usage` |
| `error` | Error with message, optional `code` and `hint` |

**Thinking content**: Live reasoning streams as `thinking_delta`. Historical reasoning is projected from Hermes `reasoning_content` / `reasoning` into `msg.thinking` when available.

## Client Routes

| Path | Component | Description |
|------|-----------|-------------|
| `/` | `Board` | Kanban board (3 columns + drag-and-drop) |
| `/tasks/new` | `NewTaskPage` | Create task + initial chat with agent |
| `/tasks/:taskId` | `TaskDetailPage` | Task detail + chat thread |
| `/scheduled-tasks` | `ScheduledTasksPage` | Create and manage recurring Hermes scheduled tasks |
| `/cron` | redirect | Browser bookmark redirect to `/scheduled-tasks` |
| `/skills` | redirect | Redirects to `/skills/browse` |
| `/skills/:tab` | `SkillsPage` | Browse the ClawHub registry or manage installed skills (`browse` / `installed` tab) |
| `/files` | `FileBrowserPage` | File manager for workspace directory |
| `/settings` | `SettingsPage` | Theme, default model + reasoning effort |

## Environment Variables

All optional — defaults work for local development.

```bash
PORT=7460                        # Web server port
HERMES_PYTHON=                   # Path to Python with Hermes deps (auto-detected if unset)
HERMES_AGENT_DIR=                # Path to Hermes agent dir (default: ~/.hermes/hermes-agent)
HERMES_AGENT_RUN_LIMIT=10        # Max concurrent AIAgent.run_conversation calls
AGENTCONTROL_HOME=~/.agentcontrol          # State directory (DB, logs, backups, workspace)
DB_PATH=~/.agentcontrol/data/agentcontrol.db  # SQLite database path
MINIONS_MODEL_LIST_CACHE_TTL_SECONDS=60  # Cache TTL for model list in Python worker
```

## Hermes Python Library

The Python worker imports Hermes `AIAgent` from the local agent directory (not via pip). Key API surface used:

- **`AIAgent(model, provider, session_id, session_db, ...)`**: Constructor takes model/provider config, session tracking, callbacks for streaming deltas, and tool configuration. Create one instance per conversation turn — not thread-safe across concurrent calls.
- **`agent.run_conversation(user_message, system_message, conversation_history, task_id)`**: Full control method returning `{"final_response", "messages", "input_tokens", "output_tokens", ...}`. The worker passes sanitized history from `SessionDB.get_messages_as_conversation()` as `conversation_history`.
- **`SessionDB`**: From `hermes_state` module. Used for `get_messages()` (raw rows for chat projection), `get_messages_as_conversation()` (formatted history for agent replay), `get_session()` (session metadata with token counts/cost), and `resolve_resume_session_id()` (follow session chains).
- **Callbacks**: `stream_delta_callback` (text), `reasoning_callback` (thinking), `tool_progress_callback` (tool lifecycle events). These are passed to the constructor and fire during `run_conversation()`.

Docs: https://hermes-agent.nousresearch.com/docs/guides/python-library

## Future

- **Additional adapters**: The `AgentAdapter` interface (`server/adapters/types.ts`) is pluggable. Other OpenAI-compatible backends (OpenClaw, LiteLLM, etc.) could implement it.
