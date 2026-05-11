export const TASK_STATUSES = ['in_progress', 'in_review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface AgentRunSettings {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  agent_model: string | null;
  reasoning_effort: ReasoningEffort | null;
  created_at: number;
  updated_at: number;
  last_agent_response_at: number | null;
  last_viewed_at: number | null;
  last_usage_input_tokens: number | null;
  last_usage_output_tokens: number | null;
  last_usage_total_tokens: number | null;
}

export interface TaskMessage {
  id: string;
  task_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  usage?: UsageStats;
  created_at: number;
}

export interface ToolProgressEvent {
  tool: string;
  status: 'running' | 'completed' | 'error';
  duration?: number;
  label?: string;
}

export type LiveChatRunStatus = 'streaming' | 'done' | 'error';

export interface TaskRunState {
  taskId: string;
  runId: string;
  status: LiveChatRunStatus;
  startedAt: number;
  updatedAt: number;
}

export type BoardEvent =
  | { type: 'task_created'; task: Task }
  | { type: 'task_updated'; task: Task }
  | { type: 'task_deleted'; taskId: string }
  | { type: 'task_runs_snapshot'; runs: TaskRunState[] }
  | { type: 'task_run_updated'; run: TaskRunState };

export type LiveChatMessage = TaskMessage & { tools?: ToolProgressEvent[] };

export interface LiveChatRun {
  taskId: string;
  runId: string;
  sessionId: string;
  status: LiveChatRunStatus;
  startedAt: number;
  updatedAt: number;
  messages: LiveChatMessage[];
  usage?: UsageStats;
  error?: string;
}

export interface UsageStats {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface SessionMetadata {
  id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number | null;
  cost_status: string | null;
  model: string | null;
}

export interface AgentDefaults {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  apiMode: string | null;
  reasoningEffort: ReasoningEffort | null;
  showReasoning: boolean;
}

export interface AgentModelOption {
  id: string;
  label: string;
  source: 'current' | 'catalog' | 'custom' | 'alias';
  isCurrentDefault?: boolean;
}

export interface AgentModelGroup {
  provider: string;
  models: AgentModelOption[];
}

export interface AgentModelsResponse {
  defaultModel: string | null;
  activeProvider: string | null;
  groups: AgentModelGroup[];
}

export interface TaskAgentSettings {
  task: {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
  };
  defaults: AgentDefaults;
  effective: {
    model: string | null;
    provider: string | null;
    reasoningEffort: ReasoningEffort | null;
  };
}

export interface CronJobOrigin {
  platform?: string | null;
  chat_id?: string | null;
  chat_name?: string | null;
  thread_id?: string | null;
  [key: string]: unknown;
}

export interface CronJob {
  id: string;
  name: string;
  prompt: string | null;
  schedule: Record<string, unknown> | null;
  scheduleDisplay: string | null;
  enabled: boolean;
  state: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: CronStatus | null;
  lastError: string | null;
  lastDeliveryError: string | null;
  model: string | null;
  provider: string | null;
  baseUrl: string | null;
  deliver: string | null;
  origin: CronJobOrigin | null;
  skills: string[];
  createdAt: string | null;
  linkedTaskIds?: string[];
}

export type CronStatus = 'ok' | 'error' | 'unknown';

export interface CronRun {
  id: string;
  jobId: string;
  ranAt: string | null;
  path: string;
  status: CronStatus;
  preview: string;
  content?: string;
}

export type FileEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface FileEntry {
  name: string;
  path: string;
  displayPath: string;
  type: FileEntryType;
  hidden: boolean;
  size: number | null;
  modifiedAt: number | null;
  readable: boolean;
  writable: boolean;
}

export interface FileListResponse {
  path: string;
  displayPath: string;
  parentPath: string | null;
  entries: FileEntry[];
}

export interface FileReadResponse {
  path: string;
  displayPath: string;
  name: string;
  content: string;
  size: number;
  modifiedAt: number;
  encoding: 'utf8';
  fileType: 'text';
}

export interface FileWriteResponse {
  path: string;
  displayPath: string;
  size: number;
  modifiedAt: number;
}

export type FileCreateType = 'file' | 'directory';

export interface FileCreateResponse {
  entry: FileEntry;
}

export interface FileRenameResponse {
  entry: FileEntry;
}

export interface FileDeleteResponse {
  ok: true;
}

export interface FileUploadResponse {
  uploaded: number;
  entries: FileEntry[];
}
