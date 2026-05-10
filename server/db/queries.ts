import { v4 as uuid } from 'uuid';
import db from './index.js';
import {
  DEFAULT_HEARTBEAT_SETTINGS,
  MIN_HEARTBEAT_MINUTES,
  MAX_HEARTBEAT_MINUTES,
  type Task,
  type TaskStatus,
  type HeartbeatLogEntry,
  type HeartbeatSettings,
  type ReasoningEffort,
} from '../../shared/types.js';

const stmtAllTasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC');
const stmtTasksByStatus = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC');
const stmtGetTask = db.prepare('SELECT * FROM tasks WHERE id = ?');
const stmtInsertTask = db.prepare(`
  INSERT INTO tasks (
    id, title, description, status, agent_model, reasoning_effort,
    created_at, updated_at, last_agent_response_at, last_viewed_at
  )
  VALUES (
    @id, @title, @description, @status, @agent_model, @reasoning_effort,
    @created_at, @updated_at, @last_agent_response_at, @last_viewed_at
  )
`);
const stmtDeleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');
const stmtTouchTask = db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?');
const stmtMarkTaskViewed = db.prepare(`
  UPDATE tasks
  SET last_viewed_at = last_agent_response_at
  WHERE id = ?
    AND last_agent_response_at IS NOT NULL
    AND (last_viewed_at IS NULL OR last_viewed_at < last_agent_response_at)
`);
const stmtHeartbeatByTask = db.prepare('SELECT * FROM heartbeat_log WHERE task_id = ? ORDER BY created_at DESC LIMIT ?');
const stmtHeartbeatAll = db.prepare('SELECT * FROM heartbeat_log ORDER BY created_at DESC LIMIT ?');
const stmtInsertHeartbeat = db.prepare(`
  INSERT INTO heartbeat_log (id, task_id, action, details, created_at)
  VALUES (?, ?, ?, ?, ?)
`);
const stmtGetHeartbeatSettings = db.prepare(
  'SELECT key, value FROM app_settings WHERE key IN (?, ?)'
);
const stmtSetAppSetting = db.prepare(`
  INSERT INTO app_settings (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

const HEARTBEAT_INTERVAL_KEY = 'heartbeat_interval_mins';
const HEARTBEAT_IDLE_KEY = 'heartbeat_idle_mins';

export function getAllTasks(status?: TaskStatus): Task[] {
  return status ? stmtTasksByStatus.all(status) as Task[] : stmtAllTasks.all() as Task[];
}

export function getTask(id: string): Task | undefined {
  return stmtGetTask.get(id) as Task | undefined;
}

export function insertTask(task: {
  title: string;
  description?: string | null;
  status: TaskStatus;
  agent_model?: string | null;
  reasoning_effort?: ReasoningEffort | null;
  last_agent_response_at?: number | null;
}): Task {
  const id = uuid();
  const now = Date.now();
  const row = {
    id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    agent_model: task.agent_model ?? null,
    reasoning_effort: task.reasoning_effort ?? null,
    created_at: now,
    updated_at: now,
    last_agent_response_at: task.last_agent_response_at ?? null,
    last_viewed_at: null,
  };
  stmtInsertTask.run(row);
  return row as Task;
}

const ALLOWED_UPDATE_FIELDS = new Set<string>([
  'title',
  'description',
  'status',
  'agent_model',
  'reasoning_effort',
  'last_agent_response_at',
]);
const updateStmtCache = new Map<string, ReturnType<typeof db.prepare>>();

function getUpdateStmt(fieldKeys: string[]): ReturnType<typeof db.prepare> {
  const key = fieldKeys.join(',');
  let stmt = updateStmtCache.get(key);
  if (!stmt) {
    const sets = fieldKeys.map(f => `${f} = @${f}`).join(', ');
    stmt = db.prepare(`UPDATE tasks SET ${sets}, updated_at = @updated_at WHERE id = @id`);
    updateStmtCache.set(key, stmt);
  }
  return stmt;
}

export function updateTask(
  id: string,
  fields: Partial<Pick<Task, 'title' | 'description' | 'status' | 'agent_model' | 'reasoning_effort' | 'last_agent_response_at'>>,
): Task | undefined {
  const fieldKeys: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_UPDATE_FIELDS.has(key)) continue;
    fieldKeys.push(key);
    values[key] = value ?? null;
  }

  if (fieldKeys.length === 0) return getTask(id);

  values.updated_at = Date.now();
  getUpdateStmt(fieldKeys).run(values);
  return getTask(id);
}

export function touchTask(id: string): void {
  stmtTouchTask.run(Date.now(), id);
}

export function recordAgentResponse(taskId: string, at = Date.now()): Task | undefined {
  return updateTask(taskId, { last_agent_response_at: at });
}

export function markTaskViewed(id: string): { task: Task | undefined; changed: boolean } {
  const result = stmtMarkTaskViewed.run(id);
  return {
    task: getTask(id),
    changed: result.changes > 0,
  };
}

export function deleteTask(id: string): boolean {
  const result = stmtDeleteTask.run(id);
  return result.changes > 0;
}

export function getHeartbeatLogs(taskId?: string, limit = 50): HeartbeatLogEntry[] {
  return taskId
    ? stmtHeartbeatByTask.all(taskId, limit) as HeartbeatLogEntry[]
    : stmtHeartbeatAll.all(limit) as HeartbeatLogEntry[];
}

export function insertHeartbeatLog(taskId: string, action: HeartbeatLogEntry['action'], details: Record<string, unknown>): HeartbeatLogEntry {
  const id = uuid();
  const now = Date.now();
  const detailsJson = JSON.stringify(details);
  stmtInsertHeartbeat.run(id, taskId, action, detailsJson, now);
  return { id, task_id: taskId, action, details: detailsJson, created_at: now };
}

function parseMinuteSetting(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_HEARTBEAT_MINUTES || value > MAX_HEARTBEAT_MINUTES) {
    return fallback;
  }
  return value;
}

function normalizeMinuteInput(value: unknown, label: string): number {
  const normalized = typeof value === 'string' ? Number(value.trim()) : value;
  if (
    typeof normalized !== 'number' ||
    !Number.isInteger(normalized) ||
    normalized < MIN_HEARTBEAT_MINUTES ||
    normalized > MAX_HEARTBEAT_MINUTES
  ) {
    throw new Error(`${label} must be an integer between ${MIN_HEARTBEAT_MINUTES} and ${MAX_HEARTBEAT_MINUTES} minutes`);
  }
  return normalized;
}

export function getHeartbeatSettings(): HeartbeatSettings {
  const rows = stmtGetHeartbeatSettings.all(HEARTBEAT_INTERVAL_KEY, HEARTBEAT_IDLE_KEY) as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    intervalMinutes: parseMinuteSetting(map.get(HEARTBEAT_INTERVAL_KEY), DEFAULT_HEARTBEAT_SETTINGS.intervalMinutes),
    idleMinutes: parseMinuteSetting(map.get(HEARTBEAT_IDLE_KEY), DEFAULT_HEARTBEAT_SETTINGS.idleMinutes),
  };
}

export function updateHeartbeatSettings(fields: Partial<HeartbeatSettings>): HeartbeatSettings {
  const now = Date.now();
  if ('intervalMinutes' in fields) {
    stmtSetAppSetting.run(HEARTBEAT_INTERVAL_KEY, String(normalizeMinuteInput(fields.intervalMinutes, 'Heartbeat interval')), now);
  }
  if ('idleMinutes' in fields) {
    stmtSetAppSetting.run(HEARTBEAT_IDLE_KEY, String(normalizeMinuteInput(fields.idleMinutes, 'Heartbeat idle delay')), now);
  }
  return getHeartbeatSettings();
}
