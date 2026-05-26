import type {
  AgentRunSettings,
  CompactResult,
  ContextUsage,
  GoalDecision,
  GoalStateSnapshot,
  ScheduledTask,
  ScheduledTaskInput,
  SessionMetadata,
  TaskMessage,
  CodeDiffSummary,
} from '../../shared/types.js';

export type { AgentRunSettings, ContextUsage };

export interface AgentRunOptions {
  systemMessage?: string;
  settings?: AgentRunSettings;
  task?: {
    id: string;
    title?: string | null;
  };
  /** Parent task context injected when this task is a delegated subtask. */
  parentTask?: {
    id: string;
    title: string;
    description?: string | null;
  } | null;
  /** The child (delegated) task ID this agent run belongs to. */
  delegatedTaskId?: string;
}

export interface StreamEvent {
  type: 'text_delta' | 'thinking_delta' | 'tool_progress' | 'done' | 'error';
  content?: string;
  error?: string;
  code?: string;
  sessionId?: string;
  tool?: string;
  status?: 'running' | 'completed' | 'error';
  duration?: number;
  label?: string;
  codeDiff?: CodeDiffSummary | null;
  context?: ContextUsage | null;
  interrupted?: boolean;
  /** The model that was used for this run, reported on 'done'. */
  model?: string | null;
  /** The provider that was used for this run, reported on 'done'. */
  provider?: string | null;
}

export interface AgentAdapter {
  chat(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): Promise<{ text: string; sessionId: string }>;

  chatStream(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): AsyncIterable<StreamEvent>;

  interruptChat(sessionId: string, reason?: string): Promise<boolean>;

  healthCheck(): Promise<boolean>;

  getMessages(sessionId: string, taskId: string): Promise<TaskMessage[]>;

  getSessionMetadata(sessionId: string): Promise<SessionMetadata | null>;

  generateTitle(description: string): Promise<{ title: string }>;

  compressSession(
    sessionId: string,
    options?: {
      focusTopic?: string | null;
      currentTokens?: number | null;
      systemMessage?: string;
      settings?: AgentRunSettings;
    },
  ): Promise<CompactResult>;

  getGoalStatus(sessionId: string): Promise<GoalStateSnapshot | null>;

  setGoal(
    sessionId: string,
    goal: string,
    options?: { maxTurns?: number | null },
  ): Promise<GoalStateSnapshot>;

  pauseGoal(sessionId: string, reason?: string): Promise<GoalStateSnapshot | null>;

  resumeGoal(sessionId: string): Promise<GoalStateSnapshot | null>;

  clearGoal(sessionId: string): Promise<boolean>;

  evaluateGoal(sessionId: string, responseText: string): Promise<GoalDecision>;

  listScheduledTasks(includeDisabled?: boolean, limit?: number): Promise<ScheduledTask[]>;

  getScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null>;

  createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask>;

  updateScheduledTask(scheduledTaskId: string, updates: Partial<ScheduledTaskInput>): Promise<ScheduledTask | null>;

  pauseScheduledTask(scheduledTaskId: string, reason?: string): Promise<ScheduledTask | null>;

  resumeScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null>;

  runScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null>;

  removeScheduledTask(scheduledTaskId: string): Promise<boolean>;

  tickScheduledTasks(): Promise<number>;
}
