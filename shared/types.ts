export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface AppVersion {
  name: string;
  version: string;
}

export const CHAT_RUN_MODES = ['task', 'goal'] as const;
export type ChatRunMode = (typeof CHAT_RUN_MODES)[number];
export const MINIONS_GOAL_MAX_TURNS = 20;

export const TERMINAL_WS_PATH = '/api/terminal';

export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type TerminalServerMessage =
  | { type: 'exit'; exitCode: number; signal: number | null }
  | { type: 'error'; message: string };

export interface AgentRunSettings {
  model?: string | null;
  provider?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  mode?: ChatRunMode;
}

export const DELEGATION_STATUSES = ['queued', 'running', 'review', 'blocked', 'done'] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  agent_model: string | null;
  agent_provider: string | null;
  reasoning_effort: ReasoningEffort | null;
  created_at: number;
  updated_at: number;
  last_agent_response_at: number | null;
  last_viewed_at: number | null;
  last_context_used_tokens: number | null;
  last_context_window_tokens: number | null;
  /** Parent task id for subtask hierarchy (nullable). */
  parent_task_id: string | null;
  /** Priority (higher = more important). */
  priority: number | null;
  /** JSON array of label strings. */
  labels_json: string | null;
  /** Named assignee (optional, distinct from Kanban assignee). */
  assignee: string | null;
  /** Delegation workflow status. */
  delegation_status: DelegationStatus | null;
  /** Hermes Kanban task id for delegated subtasks. */
  hermes_kanban_task_id: string | null;
  /** Delegation profile name (Hermes profile). */
  delegation_profile: string | null;
  /** Source marker: 'agentcontrol' or 'hermes-kanban-sync' (nullable). */
  external_source: string | null;
  /** GitHub PR tracking fields */
  github_pr_url: string | null;
  github_pr_number: number | null;
  github_pr_state: string | null;
  github_pr_head_ref: string | null;
  github_pr_head_sha: string | null;
  github_checks_status: string | null;
  github_checks_summary: string | null;
  github_checks_updated_at: number | null;
  /** Computed: count of direct child subtasks. Not stored in DB. */
  child_count?: number;
}

export interface TaskMessage {
  id: string;
  task_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  created_at: number;
}

export interface ToolProgressEvent {
  tool: string;
  status: 'running' | 'completed' | 'error';
  duration?: number;
  label?: string;
  codeDiff?: CodeDiffSummary | null;
}

export interface CodeDiffSummary {
  files: Array<{ status: string; path: string }>;
  fileCount: number;
  stat: string;
  patch: string;
  truncated: boolean;
  capturedAt: number;
}

export type TaskRunKind = 'chat' | 'goal' | 'compact';
export type LiveChatRunStatus = 'streaming' | 'compacting' | 'done' | 'error' | 'stopped';

export interface TaskRunState {
  taskId: string;
  runId: string;
  kind: TaskRunKind;
  status: LiveChatRunStatus;
  startedAt: number;
  updatedAt: number;
  goal?: GoalStateSnapshot | null;
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
  kind: TaskRunKind;
  sessionId: string;
  status: LiveChatRunStatus;
  startedAt: number;
  updatedAt: number;
  messages: LiveChatMessage[];
  goal?: GoalStateSnapshot | null;
  context?: ContextUsage | null;
  error?: string;
}

export interface ContextUsage {
  used_tokens: number;
  window_tokens: number;
}

export interface CompactResult {
  compressed: boolean;
  sessionId: string;
  previousMessageCount: number;
  compressedMessageCount: number;
  context?: ContextUsage | null;
}

export interface GoalStateSnapshot {
  goal: string;
  status: 'active' | 'paused' | 'done' | 'cleared';
  turnsUsed: number;
  maxTurns: number;
  lastReason?: string | null;
  pausedReason?: string | null;
}

export interface GoalDecision {
  status: GoalStateSnapshot['status'] | null;
  shouldContinue: boolean;
  continuationPrompt?: string | null;
  verdict: 'done' | 'continue' | 'skipped' | 'inactive';
  reason: string;
  message: string;
  state?: GoalStateSnapshot | null;
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
  provider?: string | null;
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
    provider: string | null;
    reasoningEffort: ReasoningEffort | null;
  };
  defaults: AgentDefaults;
  effective: {
    model: string | null;
    provider: string | null;
    reasoningEffort: ReasoningEffort | null;
  };
}

export interface KanbanTaskInfo {
  /** Hermes Kanban task id. */
  kanban_id: string;
  /** Title from Hermes Kanban. */
  title: string;
  /** Status on the Kanban board. */
  status: string;
  /** Assignee profile. */
  assignee: string | null;
  /** Task body/description. */
  body: string | null;
  /** Most recent run outcome. */
  outcome: string | null;
  /** Run summary (most recent completed run). */
  summary: string | null;
  /** Run error (most recent failed run). */
  error: string | null;
  /** Created at (epoch ms). */
  created_at: number;
  /** Started at (epoch ms, if running or done). */
  started_at: number | null;
  /** Completed at (epoch ms, if done). */
  completed_at: number | null;
  /** Current active Kanban run id, if any. */
  current_run_id: number | null;
  /** Latest Kanban run id, if any. */
  latest_run_id: number | null;
  /** Latest Kanban run status, if any. */
  latest_run_status: string | null;
  /** Latest Kanban run profile, if any. */
  latest_run_profile: string | null;
  /** Latest Kanban run metadata JSON, if any. */
  latest_run_metadata: Record<string, unknown>;
}

export interface KanbanLogEntry {
  log_id: number;
  run_id: number | null;
  event_kind: string;
  payload: Record<string, unknown>;
  created_at: number;
}

export interface KanbanRunEntry {
  run_id: number;
  profile: string | null;
  status: string;
  outcome: string | null;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  error: string | null;
  worker_pid: number | null;
}

export interface KanbanCommentEntry {
  comment_id: number;
  author: string;
  body: string;
  created_at: number;
}

export interface SubtaskInput {
  title: string;
  description?: string | null;
  delegate?: boolean;
  agent_model?: string | null;
  reasoning_effort?: ReasoningEffort | null;
  priority?: number | null;
  labels?: string[];
  assignee?: string | null;
}

export interface SubtaskResponse {
  parent: Task;
  subtasks: Task[];
}

export interface KanbanTaskResponse {
  kanban_id: string | null;
  delegation_profile: string | null;
  kanban: KanbanTaskInfo | null;
}

export interface KanbanLogsResponse {
  kanban_id: string | null;
  logs: KanbanLogEntry[];
  /** Backward-compatible alias for logs, useful for callers that prefer explicit event naming. */
  events?: KanbanLogEntry[];
  runs: KanbanRunEntry[];
  comments: KanbanCommentEntry[];
}

export interface GitHubStatusResponse {
  taskId: string;
  github_pr_url: string | null;
  github_pr_number: number | null;
  github_pr_state: string | null;
  github_pr_head_ref: string | null;
  github_pr_head_sha: string | null;
  github_checks_status: string | null;
  github_checks_summary: string | null;
  github_checks_updated_at: number | null;
}

export type GitHubMergeStatus = 'merged' | 'auto_merge_enabled' | 'blocked';

export interface GitHubMergeResponse extends GitHubStatusResponse {
  status: GitHubMergeStatus;
  merged: boolean;
  autoMergeEnabled: boolean;
  message: string;
  mergeStateStatus: string | null;
  mergeable: string | null;
  baseRefName: string | null;
}

export interface ScheduledTaskOrigin {
  platform?: string | null;
  chat_id?: string | null;
  chat_name?: string | null;
  thread_id?: string | null;
  [key: string]: unknown;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string | null;
  schedule: Record<string, unknown> | null;
  scheduleDisplay: string | null;
  enabled: boolean;
  state: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ScheduledTaskStatus | null;
  lastError: string | null;
  lastDeliveryError: string | null;
  model: string | null;
  provider: string | null;
  baseUrl: string | null;
  deliver: string | null;
  origin: ScheduledTaskOrigin | null;
  repeat: ScheduledTaskRepeat | null;
  contextFrom: string[];
  skills: string[];
  workdir: string | null;
  createdAt: string | null;
}

export type ScheduledTaskStatus = 'ok' | 'error' | 'unknown';

export interface ScheduledTaskRepeat {
  times: number | null;
  completed: number;
}

export interface ScheduledTaskRun {
  id: string;
  scheduledTaskId: string;
  ranAt: string | null;
  path: string;
  status: ScheduledTaskStatus;
  preview: string;
}

export interface ScheduledTaskRunContent {
  body: string;
  status: ScheduledTaskStatus;
}

export interface ScheduledTaskInput {
  name?: string;
  prompt: string;
  schedule: string;
  deliver?: string;
  skills?: string[];
  model?: string | null;
  provider?: string | null;
  baseUrl?: string | null;
  workdir?: string | null;
  repeat?: number | null;
  contextFrom?: string | string[] | null;
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

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  key: string;
  source: string;
  provider?: string;
  registrySlug?: string;
  version?: string;
  installedAt?: string;
}

export interface SkillInstallResult {
  skill: SkillMeta;
  installed: boolean;
  alreadyInstalled?: boolean;
}

export interface ClawHubStats {
  installsAllTime?: number;
  downloads?: number;
  installsCurrent?: number;
  stars?: number;
}

export interface ClawHubSkillSummary {
  slug: string;
  displayName: string;
  summary: string;
  version?: string | null;
  /** The latest published version string, when known. */
  latestVersion?: string | null;
  updatedAt?: number | null;
  stats?: ClawHubStats | null;
}

export interface ClawHubScanResult {
  security?: {
    status?: string;
    hasWarnings?: boolean;
  };
}
