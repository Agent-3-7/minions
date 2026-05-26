import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMinionsDbPath, ensureMinionsStateDirs } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

ensureMinionsStateDirs();

const dbPath = resolveMinionsDbPath();

const db: import('better-sqlite3').Database = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// Idempotent migrations: add columns that may already exist in upgraded DBs.
const MIGRATIONS: string[] = [
  `ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id)`,
  `ALTER TABLE tasks ADD COLUMN priority INTEGER`,
  `ALTER TABLE tasks ADD COLUMN labels_json TEXT`,
  `ALTER TABLE tasks ADD COLUMN assignee TEXT`,
  `ALTER TABLE tasks ADD COLUMN delegation_status TEXT`,
];
for (const sql of MIGRATIONS) {
  try { db.exec(sql); } catch { /* column already exists — noop */ }
}

export default db;
