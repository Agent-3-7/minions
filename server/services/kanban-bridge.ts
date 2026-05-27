/**
 * Kanban Bridge — manages the Hermes Kanban ↔ AgentControl mapping.
 *
 * Writes go through the Hermes CLI so board-side invariants stay intact.
 * Read APIs use read-only SQLite queries against the Hermes Kanban DB, which
 * gives AgentControl real task status, event logs, comments, and run history
 * without parsing terminal output.
 */

import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolveHermesHome } from '../paths.js';
import type {
  KanbanCommentEntry,
  KanbanLogEntry,
  KanbanRunEntry,
  KanbanTaskInfo,
} from '../../shared/types.js';

export const KANBAN_BOARD = 'jarvis-mission-control';

function resolveKanbanRoot(): string {
  const override = process.env.HERMES_KANBAN_HOME?.trim();
  if (override) return override;

  const hermesHome = resolveHermesHome();

  // Hermes Kanban is intentionally shared across profiles. If AgentControl is
  // launched under HERMES_HOME=~/.hermes/profiles/<profile>, collapse it back
  // to ~/.hermes, matching hermes_cli/kanban_db.py::kanban_home().
  if (basename(dirname(hermesHome)) === 'profiles') {
    return dirname(dirname(hermesHome));
  }

  return hermesHome;
}

export function getKanbanDbPath(): string {
  const direct = process.env.HERMES_KANBAN_DB?.trim();
  if (direct) return direct;

  const root = resolveKanbanRoot();
  const board = KANBAN_BOARD as string;
  return board === 'default'
    ? join(root, 'kanban.db')
    : join(root, 'kanban', 'boards', board, 'kanban.db');
}

function openKanbanDb(): Database.Database | null {
  const dbPath = getKanbanDbPath();
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { raw: value };
  }
}

function clampLimit(limit: number, fallback: number, max: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), max);
}

export function createKanbanTask(
  title: string,
  assigneeProfile: string,
  body: string,
): string {
  const stdout = execFileSync(
    'hermes',
    [
      'kanban',
      '--board',
      KANBAN_BOARD,
      'create',
      '--json',
      '--assignee',
      assigneeProfile,
      '--body',
      body,
      title,
    ],
    {
      encoding: 'utf-8',
      timeout: 30_000,
      env: {
        ...process.env,
        HERMES_KANBAN_HOME: resolveKanbanRoot(),
      },
    },
  );

  const parsed = JSON.parse(stdout.trim()) as { id?: unknown };
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new Error('Hermes Kanban create did not return a task id');
  }
  return parsed.id;
}

export function getKanbanTaskInfo(kanbanId: string | null): KanbanTaskInfo | null {
  if (!kanbanId) return null;

  const conn = openKanbanDb();
  if (!conn) return null;

  try {
    const row = conn.prepare('SELECT * FROM tasks WHERE id = ?').get(kanbanId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const latestRun = conn
      .prepare(
        `SELECT id, profile, status, outcome, summary, metadata, error, started_at, ended_at
         FROM task_runs
         WHERE task_id = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(kanbanId) as Record<string, unknown> | undefined;

    return {
      kanban_id: String(row.id),
      title: String(row.title ?? ''),
      status: String(row.status ?? ''),
      assignee: typeof row.assignee === 'string' ? row.assignee : null,
      body: typeof row.body === 'string' ? row.body : null,
      outcome: typeof latestRun?.outcome === 'string' ? latestRun.outcome : null,
      summary: typeof latestRun?.summary === 'string' ? latestRun.summary : null,
      error: typeof latestRun?.error === 'string' ? latestRun.error : null,
      created_at: Number(row.created_at ?? 0),
      started_at: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
      completed_at: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
      current_run_id: row.current_run_id === null || row.current_run_id === undefined ? null : Number(row.current_run_id),
      latest_run_id: latestRun?.id === null || latestRun?.id === undefined ? null : Number(latestRun.id),
      latest_run_status: typeof latestRun?.status === 'string' ? latestRun.status : null,
      latest_run_profile: typeof latestRun?.profile === 'string' ? latestRun.profile : null,
      latest_run_metadata: parseJsonRecord(latestRun?.metadata),
    };
  } finally {
    conn.close();
  }
}

export function getKanbanLogs(kanbanId: string | null, limit = 50): KanbanLogEntry[] {
  if (!kanbanId) return [];

  const conn = openKanbanDb();
  if (!conn) return [];

  try {
    const safeLimit = clampLimit(limit, 50, 200);
    const rows = conn
      .prepare(
        `SELECT id, run_id, kind, payload, created_at
         FROM task_events
         WHERE task_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(kanbanId, safeLimit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      log_id: Number(r.id),
      run_id: r.run_id === null || r.run_id === undefined ? null : Number(r.run_id),
      event_kind: String(r.kind ?? ''),
      payload: parseJsonRecord(r.payload),
      created_at: Number(r.created_at ?? 0),
    }));
  } finally {
    conn.close();
  }
}

export function getKanbanRuns(kanbanId: string | null, limit = 20): KanbanRunEntry[] {
  if (!kanbanId) return [];

  const conn = openKanbanDb();
  if (!conn) return [];

  try {
    const safeLimit = clampLimit(limit, 20, 100);
    const rows = conn
      .prepare(
        `SELECT id, profile, status, outcome, started_at, ended_at, summary, metadata, error, worker_pid
         FROM task_runs
         WHERE task_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(kanbanId, safeLimit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      run_id: Number(r.id),
      profile: typeof r.profile === 'string' ? r.profile : null,
      status: String(r.status ?? ''),
      outcome: typeof r.outcome === 'string' ? r.outcome : null,
      started_at: Number(r.started_at ?? 0),
      ended_at: r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at),
      summary: typeof r.summary === 'string' ? r.summary : null,
      metadata: parseJsonRecord(r.metadata),
      error: typeof r.error === 'string' ? r.error : null,
      worker_pid: r.worker_pid === null || r.worker_pid === undefined ? null : Number(r.worker_pid),
    }));
  } finally {
    conn.close();
  }
}

export function getKanbanComments(kanbanId: string | null, limit = 20): KanbanCommentEntry[] {
  if (!kanbanId) return [];

  const conn = openKanbanDb();
  if (!conn) return [];

  try {
    const safeLimit = clampLimit(limit, 20, 100);
    const rows = conn
      .prepare(
        `SELECT id, author, body, created_at
         FROM task_comments
         WHERE task_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(kanbanId, safeLimit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      comment_id: Number(r.id),
      author: String(r.author ?? ''),
      body: String(r.body ?? ''),
      created_at: Number(r.created_at ?? 0),
    }));
  } finally {
    conn.close();
  }
}
