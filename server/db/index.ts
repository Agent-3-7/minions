import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAgentControlDbPath, ensureAgentControlStateDirs } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

ensureAgentControlStateDirs();

const dbPath = resolveAgentControlDbPath();

const db: import('better-sqlite3').Database = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
const migrationSchema = schema
  // These indexes depend on columns added by the idempotent migrations below.
  // Run them after the ALTER TABLE block so fresh databases boot cleanly.
  .replace(/^CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks\(parent_task_id\);\s*$/m, '');
db.exec(migrationSchema);

// Idempotent migrations: add columns that may already exist in upgraded DBs.
const MIGRATIONS: string[] = [
  `ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id)`,
  `ALTER TABLE tasks ADD COLUMN priority INTEGER`,
  `ALTER TABLE tasks ADD COLUMN labels_json TEXT`,
  `ALTER TABLE tasks ADD COLUMN assignee TEXT`,
  `ALTER TABLE tasks ADD COLUMN delegation_status TEXT`,
  `ALTER TABLE tasks ADD COLUMN hermes_kanban_task_id TEXT`,
  `ALTER TABLE tasks ADD COLUMN delegation_profile TEXT`,
  `ALTER TABLE tasks ADD COLUMN external_source TEXT`,
  `ALTER TABLE tasks ADD COLUMN github_pr_url TEXT`,
  `ALTER TABLE tasks ADD COLUMN github_pr_number INTEGER`,
  `ALTER TABLE tasks ADD COLUMN github_pr_state TEXT`,
  `ALTER TABLE tasks ADD COLUMN github_pr_head_ref TEXT`,
  `ALTER TABLE tasks ADD COLUMN github_pr_head_sha TEXT`,
  `ALTER TABLE tasks ADD COLUMN github_checks_status TEXT`,
  `ALTER TABLE tasks ADD COLUMN github_checks_summary TEXT`,
  `ALTER TABLE tasks ADD COLUMN github_checks_updated_at INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id)`,
];
for (const sql of MIGRATIONS) {
  try { db.exec(sql); } catch { /* column/index already exists — noop */ }
}

function ensureColumn(table: string, column: string, ddl: string): void {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!info.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

ensureColumn('tasks', 'agent_provider', 'TEXT');
ensureColumn('tasks', 'hermes_kanban_task_id', 'TEXT');
ensureColumn('tasks', 'delegation_profile', 'TEXT');

// Kanban + GitHub sync columns
ensureColumn('tasks', 'external_source', 'TEXT');
ensureColumn('tasks', 'github_pr_url', 'TEXT');
ensureColumn('tasks', 'github_pr_number', 'INTEGER');
ensureColumn('tasks', 'github_pr_state', 'TEXT');
ensureColumn('tasks', 'github_pr_head_ref', 'TEXT');
ensureColumn('tasks', 'github_pr_head_sha', 'TEXT');
ensureColumn('tasks', 'github_checks_status', 'TEXT');
ensureColumn('tasks', 'github_checks_summary', 'TEXT');
ensureColumn('tasks', 'github_checks_updated_at', 'INTEGER');

// Kanban + GitHub sync columns
ensureColumn('tasks', 'hermes_kanban_task_id', 'TEXT');
ensureColumn('tasks', 'delegation_profile', 'TEXT');
ensureColumn('tasks', 'external_source', 'TEXT');
ensureColumn('tasks', 'github_pr_url', 'TEXT');
ensureColumn('tasks', 'github_pr_number', 'INTEGER');
ensureColumn('tasks', 'github_pr_state', 'TEXT');
ensureColumn('tasks', 'github_pr_head_ref', 'TEXT');
ensureColumn('tasks', 'github_pr_head_sha', 'TEXT');
ensureColumn('tasks', 'github_checks_status', 'TEXT');
ensureColumn('tasks', 'github_checks_summary', 'TEXT');
ensureColumn('tasks', 'github_checks_updated_at', 'INTEGER');

export default db;
