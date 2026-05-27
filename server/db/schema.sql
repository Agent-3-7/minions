CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'todo',
  agent_model       TEXT,
  agent_provider    TEXT,
  reasoning_effort  TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_agent_response_at  INTEGER,
  last_viewed_at    INTEGER,
  last_context_used_tokens   INTEGER,
  last_context_window_tokens INTEGER
);

-- Milestone 3: Task hierarchy / subtask columns are added by the
-- idempotent migration block in index.ts. SQLite does not support
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so keeping ALTER statements in
-- this schema file would fail on every restart after the first migration.
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id);
