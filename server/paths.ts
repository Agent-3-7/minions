import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function expandHomePrefix(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function resolveHomeAwarePath(value: string): string {
  return resolve(expandHomePrefix(value));
}

export function resolveHermesHome(): string {
  const configured = process.env.HERMES_HOME?.trim();
  return resolveHomeAwarePath(configured || '~/.hermes');
}

export function resolveMinionsHome(): string {
  const configured = process.env.MINIONS_HOME?.trim();
  return resolveHomeAwarePath(configured || '~/.minions');
}

export function resolveMinionsDataDir(): string {
  return join(resolveMinionsHome(), 'data');
}

export function resolveMinionsLogsDir(): string {
  return join(resolveMinionsHome(), 'logs');
}

export function resolveMinionsWorkspaceDir(): string {
  return join(resolveMinionsHome(), 'workspace');
}

export function resolveMinionsSkillsDir(): string {
  return join(resolveMinionsHome(), 'skills');
}

export function resolveMinionsDbPath(): string {
  const configured = process.env.DB_PATH?.trim();
  if (configured) return resolveHomeAwarePath(configured);
  return join(resolveMinionsDataDir(), 'minions.db');
}

export function ensureMinionsStateDirs(): void {
  const dbPath = resolveMinionsDbPath();
  mkdirSync(resolveMinionsDataDir(), { recursive: true });
  mkdirSync(resolveMinionsLogsDir(), { recursive: true });
  mkdirSync(resolveMinionsWorkspaceDir(), { recursive: true });
  mkdirSync(resolveMinionsSkillsDir(), { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });
}
