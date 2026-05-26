import type {
  AgentDefaults,
  AgentModelsResponse,
  GoalDecision,
  GoalStateSnapshot,
  ScheduledTask,
  ScheduledTaskInput,
  SessionMetadata,
  TaskMessage,
  ContextUsage,
} from '../../shared/types.js';
import type { AgentRunSettings } from './types.js';

export type WorkerRequest =
  | { id: string; type: 'health' }
  | { id: string; type: 'settings.get' }
  | { id: string; type: 'settings.set'; provider?: string | null; model?: string | null; reasoningEffort?: string | null }
  | { id: string; type: 'models.list' }
  | { id: string; type: 'scheduledTasks.list'; includeDisabled?: boolean; limit?: number }
  | { id: string; type: 'scheduledTasks.get'; scheduledTaskId: string }
  | { id: string; type: 'scheduledTasks.create' } & ScheduledTaskInput
  | { id: string; type: 'scheduledTasks.update'; scheduledTaskId: string } & Partial<ScheduledTaskInput>
  | { id: string; type: 'scheduledTasks.pause'; scheduledTaskId: string; reason?: string }
  | { id: string; type: 'scheduledTasks.resume'; scheduledTaskId: string }
  | { id: string; type: 'scheduledTasks.run'; scheduledTaskId: string }
  | { id: string; type: 'scheduledTasks.remove'; scheduledTaskId: string }
  | { id: string; type: 'scheduledTasks.tick' }
  | { id: string; type: 'session.messages.get'; sessionId: string; taskId?: string }
  | { id: string; type: 'session.get'; sessionId: string }
  | { id: string; type: 'goal.status'; sessionId: string }
  | { id: string; type: 'goal.set'; sessionId: string; goal: string; maxTurns?: number | null }
  | { id: string; type: 'goal.pause'; sessionId: string; reason?: string }
  | { id: string; type: 'goal.resume'; sessionId: string }
  | { id: string; type: 'goal.clear'; sessionId: string }
  | { id: string; type: 'goal.evaluate'; sessionId: string; responseText: string }
  | { id: string; type: 'chat.interrupt'; taskId?: string; sessionId?: string; reason?: string }
  | {
      id: string;
      type: 'chat';
      sessionId: string;
      message: string;
      systemMessage?: string;
      settings: AgentRunSettings;
      taskId?: string;
      taskTitle?: string | null;
      /** Parent task context injected for delegated subissues. */
      parentTask?: {
        id: string;
        title: string;
        description?: string | null;
      } | null;
      /** The delegated child task ID for this agent run. */
      delegatedTaskId?: string;
    }
  | {
      id: string;
      type: 'title.generate';
      description: string;
    }
  | {
      id: string;
      type: 'session.compress';
      sessionId: string;
      focusTopic?: string | null;
      currentTokens?: number | null;
      systemMessage?: string;
      settings?: AgentRunSettings;
    };

export interface WorkerErrorPayload {
  message: string;
  code?: string;
  hint?: string;
}

export type WorkerResult =
  | { ok: boolean; agentDir?: string | null; python?: string | null }
  | AgentDefaults
  | AgentModelsResponse
  | { scheduledTasks: ScheduledTask[] }
  | { scheduledTask: ScheduledTask | null }
  | { executed: number }
  | { messages: TaskMessage[] }
  | { session: SessionMetadata | null }
  | { goal: GoalStateSnapshot | null }
  | { cleared: boolean }
  | { interrupted: boolean }
  | GoalDecision
  | { title: string }
  | {
      compressed: boolean;
      sessionId: string;
      previousMessageCount: number;
      compressedMessageCount: number;
      context?: ContextUsage | null;
    };

export type WorkerEvent =
  | { id: string; type: 'result'; data: WorkerResult }
  | { id: string; type: 'text_delta'; content?: string }
  | { id: string; type: 'thinking_delta'; content?: string }
  | {
      id: string;
      type: 'tool_progress';
      tool?: string;
      status?: 'running' | 'completed' | 'error';
      duration?: number;
      label?: string | null;
    }
  | { id: string; type: 'done'; sessionId?: string; context?: ContextUsage | null; interrupted?: boolean; model?: string | null; provider?: string | null }
  | { id: string; type: 'error'; error: string | WorkerErrorPayload };
