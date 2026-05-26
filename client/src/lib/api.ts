import type {
  AgentDefaults,
  AgentModelsResponse,
  AgentRunSettings,
  AppVersion,
  CompactResult,
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
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskRunContent,
  SkillMeta,
  SkillInstallResult,
  ClawHubSkillSummary,
  ClawHubScanResult,
  SubtaskInput,
  SubtaskResponse,
} from '@shared/types';

export type { SkillMeta, SkillInstallResult };

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

export function fetchTask(id: string) {
  return request<{ task: Task }>(`/tasks/${id}`);
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

export function patchTask(id: string, fields: { title?: string; description?: string; status?: TaskStatus; priority?: number | null; labels_json?: string | null; assignee?: string | null; delegation_status?: string | null }) {
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

export function updateAgentDefaults(updates: { provider?: string | null; model?: string | null; reasoningEffort?: ReasoningEffort | null }) {
  return request<AgentDefaults>('/agent/defaults', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function fetchTaskAgentSettings(taskId: string) {
  return request<TaskAgentSettings>(`/tasks/${taskId}/agent-settings`);
}

export function compactTask(taskId: string, focusTopic?: string | null) {
  return request<CompactResult>(`/tasks/${taskId}/compact`, {
    method: 'POST',
    body: JSON.stringify(focusTopic ? { focusTopic } : {}),
  });
}

export function interruptTask(taskId: string, reason?: string) {
  return request<{ interrupted: boolean }>(`/tasks/${taskId}/interrupt`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function fetchSubtasks(taskId: string) {
  return request<SubtaskResponse>(`/tasks/${taskId}/subtasks`);
}

export function createSubtask(taskId: string, input: SubtaskInput) {
  return request<SubtaskResponse>(`/tasks/${taskId}/subtasks`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function fetchScheduledTasks(includeDisabled = true, limit = 100) {
  return request<{ scheduledTasks: ScheduledTask[] }>(`/scheduled-tasks?includeDisabled=${includeDisabled ? 'true' : 'false'}&limit=${limit}`);
}

export function fetchScheduledTask(scheduledTaskId: string) {
  return request<{ scheduledTask: ScheduledTask | null }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}`);
}

export function createScheduledTask(input: ScheduledTaskInput) {
  return request<{ scheduledTask: ScheduledTask }>('/scheduled-tasks', {
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

export function deleteSkill(id: string) {
  return request<{ ok: boolean; skill: SkillMeta }>(`/skills/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function installSkill(input: { provider?: 'clawhub'; slug: string; version?: string; force?: boolean }) {
  return request<SkillInstallResult>('/skills/install', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function importSkillFiles(
  files: File[],
  relativePathFor: (file: File) => string = fileRelativePath,
  signal?: AbortSignal,
) {
  const formData = new FormData();

  for (const file of files) {
    formData.append('files', file, file.name);
    formData.append('relativePaths', relativePathFor(file));
  }

  return request<SkillInstallResult>('/skills/import', {
    method: 'POST',
    body: formData,
    signal,
  });
}

export function searchClawHubSkills(query: string, limit = 24): Promise<ClawHubSkillSummary[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return request<{ skills: ClawHubSkillSummary[] }>(`/skills/registry/search?${params}`).then((res) => res.skills);
}

export function browseClawHubSkills(limit = 24): Promise<ClawHubSkillSummary[]> {
  return request<{ skills: ClawHubSkillSummary[] }>(`/skills/registry/browse?limit=${limit}`).then((res) => res.skills);
}

export function fetchClawHubSkillContent(slug: string, version?: string | null): Promise<string> {
  const suffix = version ? `?version=${encodeURIComponent(version)}` : '';
  return request<{ content: string }>(`/skills/registry/${encodeURIComponent(slug)}/content${suffix}`).then((res) => res.content);
}

export function fetchClawHubSkillScan(slug: string, version?: string | null): Promise<ClawHubScanResult> {
  const suffix = version ? `?version=${encodeURIComponent(version)}` : '';
  return request<ClawHubScanResult>(`/skills/registry/${encodeURIComponent(slug)}/scan${suffix}`);
}

export const WORKSPACE_ROOT = '~/.agentcontrol/workspace';

export function listFiles(path = WORKSPACE_ROOT) {
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

export function uploadFileEntries(
  parentPath: string,
  files: File[],
  relativePathFor: (file: File) => string = fileRelativePath,
  signal?: AbortSignal,
) {
  const formData = new FormData();
  formData.append('targetPath', parentPath);

  for (const file of files) {
    formData.append('files', file, file.name);
    formData.append('relativePaths', relativePathFor(file));
  }

  return request<FileUploadResponse>('/files/upload', {
    method: 'POST',
    body: formData,
    signal,
  });
}

export function deleteFileEntry(path: string, recursive = false) {
  return request<FileDeleteResponse>('/files', {
    method: 'DELETE',
    body: JSON.stringify({ path, recursive }),
  });
}

export function updateScheduledTask(scheduledTaskId: string, updates: Partial<ScheduledTaskInput>) {
  return request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function fetchScheduledTaskRuns(scheduledTaskId: string, limit = 50) {
  return request<{ runs: ScheduledTaskRun[] }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/runs?limit=${limit}`);
}

export function fetchScheduledTaskRunContent(scheduledTaskId: string, runId: string) {
  return request<{ content: ScheduledTaskRunContent }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/runs/${encodeURIComponent(runId)}/content`);
}

export function pauseScheduledTask(scheduledTaskId: string, reason?: string) {
  return request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/pause`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function resumeScheduledTask(scheduledTaskId: string) {
  return request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/resume`, {
    method: 'POST',
  });
}

export function runScheduledTask(scheduledTaskId: string) {
  return request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}/run`, {
    method: 'POST',
  });
}

export function deleteScheduledTask(scheduledTaskId: string) {
  return request<{ ok: boolean }>(`/scheduled-tasks/${encodeURIComponent(scheduledTaskId)}`, {
    method: 'DELETE',
  });
}

export async function uploadChatAttachment(
  bucketId: string,
  fileId: string,
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  // fileId (a UUID) prefixes the name so same-named files don't collide and a
  // single attachment can be deleted by its own path.
  const relativePath = `uploads/${bucketId}/${fileId}-${file.name}`;
  await uploadFileEntries(WORKSPACE_ROOT, [file], () => relativePath, signal);
  return `${WORKSPACE_ROOT}/${relativePath}`;
}

function fileRelativePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relativePath && relativePath.length > 0 ? relativePath : file.name;
}
