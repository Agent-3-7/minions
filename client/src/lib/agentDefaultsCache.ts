import { REASONING_EFFORTS, type AgentDefaults, type ReasoningEffort } from '@shared/types';

const AGENT_DEFAULTS_CACHE_KEY = 'agentcontrol.agentDefaults.v1';

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isReasoningEffort(value: unknown): value is ReasoningEffort | null {
  return value === null || (
    typeof value === 'string' &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

function isAgentDefaults(value: unknown): value is AgentDefaults {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    isNullableString(record.provider) &&
    isNullableString(record.model) &&
    isNullableString(record.baseUrl) &&
    isNullableString(record.apiMode) &&
    isReasoningEffort(record.reasoningEffort) &&
    typeof record.showReasoning === 'boolean'
  );
}

export function readCachedAgentDefaults(): AgentDefaults | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AGENT_DEFAULTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isAgentDefaults(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCachedAgentDefaults(defaults: AgentDefaults): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AGENT_DEFAULTS_CACHE_KEY, JSON.stringify(defaults));
  } catch {
    // Defaults cache only improves first paint; failed writes should not block the app.
  }
}
