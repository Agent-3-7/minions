import type {
  AgentDefaults,
  AgentModelsResponse,
  AgentRunSettings,
  AppVersion,
  FileCreateResponse,
  FileCreateType,
  FileDeleteResponse,
  FileListResponse,
  FileReadResponse,
  FileRenameResponse,
  FileUploadResponse,
  FileWriteResponse,
  ContextUsage,
  SessionMetadata,
  Task,
  TaskAgentSettings,
  TaskMessage,
  TaskStatus,
  ReasoningEffort,
  Routine,
  RoutineInput,
  RoutineRun,
  RoutineRunContent,
} from '@shared/types';

export type { AgentRunSettings };

export const BASE = '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

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
  const isFormDataBody = typeof FormData !== 'undefined' && rest.body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    headers: isFormDataBody
      ? extraHeaders
      : { 'Content-Type': 'application/json', ...extraHeaders as Record<string, string> },
    ...rest,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined;
    throw new ApiError(message, res.status, code);
  }
  return res.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function markTaskViewed(id: string) {
  return request<{ task: Task }>(`/tasks/${id}/viewed`, {
    method: 'POST',
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
  return request<{ messages: TaskMessage[]; context?: ContextUsage | null }>(`/tasks/${taskId}/messages`);
}

export function fetchSession(taskId: string) {
  return request<{ session: SessionMetadata | null }>(`/tasks/${taskId}/session`);
}

export function fetchHealth() {
  return request<{ ok: boolean; hermes: boolean }>('/health');
}

export function fetchAppVersion() {
  return request<AppVersion>('/version');
}

export function fetchAgentDefaults() {
  return request<AgentDefaults>('/agent/defaults');
}

export function fetchAgentModels() {
  return request<AgentModelsResponse>('/agent/models');
}

export function updateAgentDefaults(updates: { model?: string | null; reasoningEffort?: ReasoningEffort | null }) {
  return request<AgentDefaults>('/agent/defaults', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function fetchTaskAgentSettings(taskId: string) {
  return request<TaskAgentSettings>(`/tasks/${taskId}/agent-settings`);
}


export function fetchRoutines(includeDisabled = true) {
  return request<{ jobs: Routine[] }>(`/routines/jobs?includeDisabled=${includeDisabled ? 'true' : 'false'}`);
}

export function fetchRoutine(jobId: string) {
  return request<{ job: Routine | null }>(`/routines/jobs/${encodeURIComponent(jobId)}`);
}

export function createRoutine(input: RoutineInput) {
  return request<{ job: Routine }>('/routines/jobs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function fetchSkills() {
  return request<{ skills: SkillMeta[] }>('/skills');
}

export function fetchSkillContent(id: string) {
  return request<{ skill: SkillMeta; content: string }>(`/skills/${encodeURIComponent(id)}/content`);
}

export function listFiles(path = '~/.minions/workspace') {
  return request<FileListResponse>(`/files/list?path=${encodeURIComponent(path)}`);
}

export function readFile(path: string) {
  return request<FileReadResponse>(`/files/read?path=${encodeURIComponent(path)}`);
}

export function fileDownloadUrl(path: string) {
  return `${BASE}/files/download?path=${encodeURIComponent(path)}`;
}

export function writeFile(path: string, content: string, expectedModifiedAt?: number, overwrite = false) {
  return request<FileWriteResponse>('/files/write', {
    method: 'PUT',
    body: JSON.stringify({ path, content, expectedModifiedAt, overwrite }),
  });
}

export function createFileEntry(parentPath: string, name: string, type: FileCreateType, content?: string) {
  return request<FileCreateResponse>('/files/create', {
    method: 'POST',
    body: JSON.stringify({ parentPath, name, type, content }),
  });
}

export function renameFileEntry(path: string, newName: string) {
  return request<FileRenameResponse>('/files/rename', {
    method: 'PATCH',
    body: JSON.stringify({ path, newName }),
  });
}

export function uploadFileEntries(parentPath: string, files: File[]) {
  const formData = new FormData();
  formData.append('targetPath', parentPath);

  for (const file of files) {
    const relativePath = fileRelativePath(file);
    formData.append('files', file, file.name);
    formData.append('relativePaths', relativePath);
  }

  return request<FileUploadResponse>('/files/upload', {
    method: 'POST',
    body: formData,
  });
}

export function deleteFileEntry(path: string, recursive = false) {
  return request<FileDeleteResponse>('/files', {
    method: 'DELETE',
    body: JSON.stringify({ path, recursive }),
  });
}

export function updateRoutine(jobId: string, updates: Partial<RoutineInput>) {
  return request<{ job: Routine }>(`/routines/jobs/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function fetchRoutineRuns(jobId: string, limit = 20) {
  return request<{ runs: RoutineRun[] }>(`/routines/jobs/${encodeURIComponent(jobId)}/runs?limit=${limit}`);
}

export function fetchRoutineRunContent(jobId: string, runId: string) {
  return request<{ content: RoutineRunContent }>(`/routines/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}/content`);
}

export function pauseRoutine(jobId: string, reason?: string) {
  return request<{ job: Routine }>(`/routines/jobs/${encodeURIComponent(jobId)}/pause`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function resumeRoutine(jobId: string) {
  return request<{ job: Routine }>(`/routines/jobs/${encodeURIComponent(jobId)}/resume`, {
    method: 'POST',
  });
}

export function runRoutine(jobId: string) {
  return request<{ job: Routine }>(`/routines/jobs/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
  });
}

export function deleteRoutine(jobId: string) {
  return request<{ ok: boolean }>(`/routines/jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
}

function fileRelativePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relativePath && relativePath.length > 0 ? relativePath : file.name;
}
