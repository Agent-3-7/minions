import type {
  AgentDefaults,
  AgentModelsResponse,
  AgentRunSettings,
  CronJob,
  CronRun,
  SessionMetadata,
  Task,
  TaskAgentSettings,
  TaskMessage,
  TaskStatus,
  HeartbeatSettings,
} from '@shared/types';

export type { AgentRunSettings };

export const BASE = '/api';

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  key: string;
  source: string;
  bundled: boolean;
  readOnly: boolean;
  autoIncluded: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: extraHeaders, ...rest } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...extraHeaders as Record<string, string> },
    ...rest,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export function fetchTasks() {
  return request<{ tasks: Task[] }>('/tasks');
}

export function moveTask(id: string, status: TaskStatus) {
  return request<{ task: Task }>(`/tasks/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

export function deleteTask(id: string) {
  return request<{ ok: boolean }>(`/tasks/${id}`, { method: 'DELETE' });
}

export function patchTask(id: string, fields: { title?: string; description?: string; status?: TaskStatus }) {
  return request<{ task: Task }>(`/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

export function createTask(
  description: string,
  title?: string,
) {
  return request<{ task: Task }>('/tasks', {
    method: 'POST',
    body: JSON.stringify({ description, title }),
  });
}

export function fetchMessages(taskId: string) {
  return request<{ messages: TaskMessage[] }>(`/tasks/${taskId}/messages`);
}

export function fetchSession(taskId: string) {
  return request<{ session: SessionMetadata | null }>(`/tasks/${taskId}/session`);
}

export function fetchHealth() {
  return request<{ ok: boolean; hermes: boolean }>('/health');
}

export function fetchAgentDefaults() {
  return request<AgentDefaults>('/agent/defaults');
}

export function fetchAgentModels() {
  return request<AgentModelsResponse>('/agent/models');
}

export function fetchTaskAgentSettings(taskId: string) {
  return request<TaskAgentSettings>(`/tasks/${taskId}/agent-settings`);
}


export function fetchCronJobs(includeDisabled = true) {
  return request<{ jobs: CronJob[] }>(`/cron/jobs?includeDisabled=${includeDisabled ? 'true' : 'false'}`);
}

export function fetchSkills() {
  return request<{ skills: SkillMeta[] }>('/skills');
}

export function fetchSkillContent(id: string) {
  return request<{ skill: SkillMeta; content: string }>(`/skills/${encodeURIComponent(id)}/content`);
}

export function fetchCronRuns(jobId: string, limit = 20) {
  return request<{ runs: CronRun[] }>(`/cron/jobs/${encodeURIComponent(jobId)}/runs?limit=${limit}`);
}

export function fetchCronRunContent(jobId: string, runId: string) {
  return request<{ content: string }>(`/cron/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}/content`);
}

export function pauseCronJob(jobId: string, reason?: string) {
  return request<{ job: CronJob }>(`/cron/jobs/${encodeURIComponent(jobId)}/pause`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function resumeCronJob(jobId: string) {
  return request<{ job: CronJob }>(`/cron/jobs/${encodeURIComponent(jobId)}/resume`, {
    method: 'POST',
  });
}

export function runCronJob(jobId: string) {
  return request<{ job: CronJob }>(`/cron/jobs/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
  });
}

export function deleteCronJob(jobId: string) {
  return request<{ ok: boolean }>(`/cron/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
}

export function fetchHeartbeatLogs(taskId: string, limit = 50) {
  return request<{ logs: import('@shared/types').HeartbeatLogEntry[] }>(`/heartbeat/log?task_id=${taskId}&limit=${limit}`);
}

export function fetchHeartbeatSettings() {
  return request<{ settings: HeartbeatSettings }>('/heartbeat/settings');
}

export function updateHeartbeatSettings(settings: Partial<HeartbeatSettings>) {
  return request<{ settings: HeartbeatSettings }>('/heartbeat/settings', {
    method: 'PATCH',
    body: JSON.stringify(settings),
  });
}
