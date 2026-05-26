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

export function resolveAgentControlHome(): string {
  const configured = process.env.AGENTCONTROL_HOME?.trim() || process.env.MINIONS_HOME?.trim();
  return resolveHomeAwarePath(configured || '~/.agentcontrol');
}

export const resolveMinionsHome = resolveAgentControlHome;

export function resolveAgentControlDataDir(): string {
  return join(resolveAgentControlHome(), 'data');
}
export const resolveMinionsDataDir = resolveAgentControlDataDir;

export function resolveAgentControlLogsDir(): string {
  return join(resolveAgentControlHome(), 'logs');
}
export const resolveMinionsLogsDir = resolveAgentControlLogsDir;

export function resolveAgentControlWorkspaceDir(): string {
  return join(resolveAgentControlHome(), 'workspace');
}
export const resolveMinionsWorkspaceDir = resolveAgentControlWorkspaceDir;

export function resolveAgentControlSkillsDir(): string {
  return join(resolveAgentControlHome(), 'skills');
}
export const resolveMinionsSkillsDir = resolveAgentControlSkillsDir;

export function resolveAgentControlDbPath(): string {
  const configured = process.env.DB_PATH?.trim();
  if (configured) return resolveHomeAwarePath(configured);
  return join(resolveAgentControlDataDir(), 'agentcontrol.db');
}

export const resolveMinionsDbPath = resolveAgentControlDbPath;

export function ensureAgentControlStateDirs(): void {
  const dbPath = resolveAgentControlDbPath();
  mkdirSync(resolveAgentControlDataDir(), { recursive: true });
  mkdirSync(resolveAgentControlLogsDir(), { recursive: true });
  mkdirSync(resolveAgentControlWorkspaceDir(), { recursive: true });
  mkdirSync(resolveAgentControlSkillsDir(), { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });
}
export const ensureMinionsStateDirs = ensureAgentControlStateDirs;
