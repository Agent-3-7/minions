import { v4 as uuid } from 'uuid';
import db from './index.js';
import {
  type Task,
  type TaskStatus,
  type ReasoningEffort,
  type ContextUsage,
} from '../../shared/types.js';

const TASK_SELECT_WITH_CHILD_COUNT = `
  SELECT
    tasks.*,
    (
      SELECT COUNT(*)
      FROM tasks AS child_tasks
      WHERE child_tasks.parent_task_id = tasks.id
    ) AS child_count
  FROM tasks
`;

const stmtAllTasks = db.prepare(`${TASK_SELECT_WITH_CHILD_COUNT} ORDER BY updated_at DESC`);
const stmtTasksByStatus = db.prepare(`${TASK_SELECT_WITH_CHILD_COUNT} WHERE status = ? ORDER BY updated_at DESC`);
const stmtGetTask = db.prepare(`${TASK_SELECT_WITH_CHILD_COUNT} WHERE id = ?`);
const stmtInsertTask = db.prepare(`
  INSERT INTO tasks (
    id, title, description, status, agent_model, agent_provider, reasoning_effort,
    created_at, updated_at, last_agent_response_at, last_viewed_at,
    last_context_used_tokens, last_context_window_tokens,
    parent_task_id, priority, labels_json, assignee, delegation_status
  )
  VALUES (
    @id, @title, @description, @status, @agent_model, @agent_provider, @reasoning_effort,
    @created_at, @updated_at, @last_agent_response_at, @last_viewed_at,
    @last_context_used_tokens, @last_context_window_tokens,
    @parent_task_id, @priority, @labels_json, @assignee, @delegation_status
  )
`);
const stmtDeleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');
const stmtDetachSubtasks = db.prepare('UPDATE tasks SET parent_task_id = NULL, updated_at = ? WHERE parent_task_id = ?');
const stmtTouchTask = db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?');
const stmtGetSubtasks = db.prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC');
const stmtSubtaskCount = db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ?');
const stmtMarkTaskViewed = db.prepare(`
  UPDATE tasks
  SET last_viewed_at = last_agent_response_at
  WHERE id = ?
    AND last_agent_response_at IS NOT NULL
    AND (last_viewed_at IS NULL OR last_viewed_at < last_agent_response_at)
`);
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
  agent_provider?: string | null;
  reasoning_effort?: ReasoningEffort | null;
  last_agent_response_at?: number | null;
  parent_task_id?: string | null;
  priority?: number | null;
  labels_json?: string | null;
  assignee?: string | null;
  delegation_status?: string | null;
}): Task {
  const id = uuid();
  const now = Date.now();
  const row = {
    id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    agent_model: task.agent_model ?? null,
    agent_provider: task.agent_provider ?? null,
    reasoning_effort: task.reasoning_effort ?? null,
    created_at: now,
    updated_at: now,
    last_agent_response_at: task.last_agent_response_at ?? null,
    last_viewed_at: null,
    last_context_used_tokens: null,
    last_context_window_tokens: null,
    parent_task_id: task.parent_task_id ?? null,
    priority: task.priority ?? null,
    labels_json: task.labels_json ?? null,
    assignee: task.assignee ?? null,
    delegation_status: task.delegation_status ?? null,
  };
  stmtInsertTask.run(row);
  return row as Task;
}

const ALLOWED_UPDATE_FIELDS = new Set<string>([
  'title',
  'description',
  'status',
  'agent_model',
  'agent_provider',
  'reasoning_effort',
  'last_agent_response_at',
  'last_context_used_tokens',
  'last_context_window_tokens',
  'parent_task_id',
  'priority',
  'labels_json',
  'assignee',
  'delegation_status',
]);
const updateStmtCache = new Map<string, ReturnType<typeof db.prepare>>();

type TaskUpdateFields = Pick<
  Task,
  | 'title'
  | 'description'
  | 'status'
  | 'agent_model'
  | 'agent_provider'
  | 'reasoning_effort'
  | 'last_agent_response_at'
  | 'last_context_used_tokens'
  | 'last_context_window_tokens'
  | 'parent_task_id'
  | 'priority'
  | 'labels_json'
  | 'assignee'
  | 'delegation_status'
>;

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
  fields: Partial<TaskUpdateFields>,
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

export function contextFromTask(task: Task): ContextUsage | null {
  if (task.last_context_used_tokens == null || task.last_context_window_tokens == null) return null;
  return { used_tokens: task.last_context_used_tokens, window_tokens: task.last_context_window_tokens };
}

export function recordAgentResponse(taskId: string, at = Date.now(), context?: ContextUsage | null): Task | undefined {
  return updateTask(taskId, {
    last_agent_response_at: at,
    ...(context !== undefined ? {
      last_context_used_tokens: context?.used_tokens ?? null,
      last_context_window_tokens: context?.window_tokens ?? null,
    } : {}),
  });
}

export function markTaskViewed(id: string): { task: Task | undefined; changed: boolean } {
  const result = stmtMarkTaskViewed.run(id);
  return {
    task: getTask(id),
    changed: result.changes > 0,
  };
}

export function deleteTask(id: string): boolean {
  const deleteWithDetachedSubtasks = db.transaction((taskId: string): boolean => {
    const now = Date.now();
    stmtDetachSubtasks.run(now, taskId);
    const result = stmtDeleteTask.run(taskId);
    return result.changes > 0;
  });

  return deleteWithDetachedSubtasks(id);
}

export function getSubtasks(parentId: string): Task[] {
  return stmtGetSubtasks.all(parentId) as Task[];
}

export function getSubtaskCount(parentId: string): number {
  const row = stmtSubtaskCount.get(parentId) as { count: number };
  return row.count;
}
