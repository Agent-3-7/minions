import { REASONING_EFFORTS, type ReasoningEffort, type Task } from '../shared/types.js';
import type { AgentRunSettings } from './adapters/types.js';
import { isRecord } from './errors.js';

export interface AgentSettingsUpdate {
  agent_model?: string | null;
  agent_provider?: string | null;
  reasoning_effort?: ReasoningEffort | null;
}

export interface ParsedRunSettings {
  taskFields: AgentSettingsUpdate;
  hasFields: boolean;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function firstPresent(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (hasOwn(record, key)) return record[key];
  }
  return undefined;
}

function normalizeModel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('model must be a string or null');
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeProvider(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('provider must be a string or null');
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new Error(`reasoningEffort must be one of: ${REASONING_EFFORTS.join(', ')}`);
  }
  return value as ReasoningEffort;
}

function parseSettingsFields(body: unknown): AgentSettingsUpdate {
  const record = isRecord(body) ? body : {};
  const model = normalizeModel(firstPresent(record, ['agentModel', 'agent_model', 'model']));
  const provider = normalizeProvider(firstPresent(record, ['agentProvider', 'agent_provider', 'provider']));
  const reasoningEffort = normalizeReasoningEffort(firstPresent(record, ['reasoningEffort', 'reasoning_effort']));

  return {
    ...(model !== undefined ? { agent_model: model } : {}),
    ...(provider !== undefined ? { agent_provider: provider } : {}),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
  };
}

export function taskRunSettings(task: Task): AgentRunSettings {
  return {
    model: task.agent_model,
    provider: task.agent_provider,
    reasoningEffort: task.reasoning_effort,
  };
}

export function parseRunSettingsBody(body: unknown): ParsedRunSettings {
  const record = isRecord(body) ? body : {};
  const source = hasOwn(record, 'settings') ? record.settings : record;
  if (hasOwn(record, 'settings') && !isRecord(source)) {
    throw new Error('settings must be an object');
  }
  const taskFields = parseSettingsFields(source);
  return { taskFields, hasFields: Object.keys(taskFields).length > 0 };
}
