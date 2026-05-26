import { Router } from 'express';
import { contextFromTask, getTask, updateTask, touchTask, recordAgentResponse } from '../db/queries.js';
import { adapter } from '../app.js';
import { broadcast, initSSE } from '../events.js';
import {
  appendSystemMessage,
  appendUserMessage,
  applyEvent,
  broadcast as broadcastLive,
  finishRun,
  getRun,
  getRunContext,
  getRunStatus,
  sendSnapshot,
  startAssistantMessage,
  startCompactionRun,
  startGoalRun,
  startRun,
  subscribe,
  updateRunGoal,
  updateRunContext,
  updateRunStatus,
} from '../live-chat.js';
import { taskRunSettings, parseRunSettingsBody } from '../agent-settings.js';
import { TASK_AGENT_SYSTEM_PROMPT } from '../prompts/task-agent.js';
import { isRecord, toErrorMessage } from '../errors.js';
import type { StreamEvent, AgentRunOptions } from '../adapters/types.js';
import { CHAT_RUN_MODES, MINIONS_GOAL_MAX_TURNS, type ChatRunMode, type CompactResult, type ContextUsage, type GoalStateSnapshot, type Task } from '../../shared/types.js';

export const chatRouter = Router();

function hasNoSession(task: Task): boolean {
  if (task.last_agent_response_at !== null) return false;
  return getRunStatus(task.id)?.status !== 'streaming';
}

function isTaskRunActive(status: ReturnType<typeof getRunStatus>): boolean {
  return status?.status === 'streaming' || status?.status === 'compacting';
}

function isInterruptibleRun(status: ReturnType<typeof getRunStatus>): boolean {
  return status?.status === 'streaming' && (status.kind === 'chat' || status.kind === 'goal');
}

function completeTaskRun(
  taskId: string,
  runId: string,
  status: 'done' | 'error',
  ttlMs: number,
  options?: Parameters<typeof updateRunStatus>[2],
): void {
  const updated = updateRunStatus(taskId, status, options);
  if (updated) {
    broadcast({ type: 'task_run_updated', run: updated });
    broadcastRunSnapshot(taskId);
  }
  finishRun(taskId, ttlMs, runId);
}

chatRouter.get('/:id/messages', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const liveContext = getRunContext(task.id);
  const context = liveContext !== undefined ? liveContext : contextFromTask(task);
  if (hasNoSession(task)) return res.json({ messages: [], context });

  try {
    const messages = await adapter.getMessages(task.id, task.id);
    res.json({ messages, context });
  } catch (error) {
    res.status(503).json({ error: toErrorMessage(error, 'Hermes session history unavailable') });
  }
});

chatRouter.get('/:id/session', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (hasNoSession(task)) return res.json({ session: null });

  try {
    const session = await adapter.getSessionMetadata(task.id);
    res.json({ session });
  } catch (error) {
    res.status(503).json({ error: toErrorMessage(error, 'Hermes session metadata unavailable') });
  }
});

const DONE_SNAPSHOT_TTL_MS = 30_000;
const ERROR_SNAPSHOT_TTL_MS = 24 * 60 * 60_000;

function parseChatRunMode(body: unknown): ChatRunMode {
  const record = isRecord(body) ? body : {};
  const settings = isRecord(record.settings) ? record.settings : {};
  const mode = settings.mode ?? record.mode ?? 'task';
  if (CHAT_RUN_MODES.includes(mode as ChatRunMode)) return mode as ChatRunMode;
  throw new Error(`mode must be one of: ${CHAT_RUN_MODES.join(', ')}`);
}

function broadcastRunSnapshot(taskId: string): void {
  const liveRun = getRun(taskId);
  if (liveRun) broadcastLive(taskId, { type: 'snapshot', run: liveRun });
}

interface StreamChatTurnResult {
  responseText: string;
  sawDone: boolean;
  context?: ContextUsage | null;
  hadError: boolean;
  // Only consumed by the goal loop; the chat path learns it stopped via the
  // `done` event reaching applyEvent (completeOnDone=true sets status 'stopped').
  interrupted: boolean;
}

function recordCompletedAgentRun(taskId: string, context: ContextUsage | null): Task | undefined {
  const updated = recordAgentResponse(taskId, Date.now(), context);
  if (updated && updated.status === 'in_progress') {
    return updateTask(taskId, { status: 'in_review' });
  }
  return updated;
}

function taskWithDelegationStatus(task: Task, runStatus: ReturnType<typeof getRunStatus>): Task | undefined {
  if (!task.parent_task_id) return task;

  if (runStatus?.status === 'streaming') {
    if (task.delegation_status === 'running') return task;
    return updateTask(task.id, { delegation_status: 'running' });
  }

  if (runStatus?.status === 'done') {
    return updateTask(task.id, { delegation_status: 'review' });
  }

  if (runStatus?.status === 'error') {
    return updateTask(task.id, { delegation_status: 'blocked' });
  }

  if (runStatus?.status === 'stopped') {
    return updateTask(task.id, { delegation_status: 'blocked' });
  }

  return task;
}

function settleRun(taskId: string, runId: string, context: ContextUsage | null): void {
  const status = getRunStatus(taskId);
  if (status) broadcast({ type: 'task_run_updated', run: status });

  const currentTask = getTask(taskId);
  if (status?.status === 'done') {
    const updated = recordCompletedAgentRun(taskId, context);
    const delegatedTask = updated ? taskWithDelegationStatus(updated, status) : undefined;
    if (delegatedTask) broadcast({ type: 'task_updated', task: delegatedTask });
  } else {
    const delegatedTask = currentTask ? taskWithDelegationStatus(currentTask, status) : undefined;
    if (delegatedTask && delegatedTask !== currentTask) broadcast({ type: 'task_updated', task: delegatedTask });
    touchTask(taskId);
  }

  const ttl = status?.status === 'error' ? ERROR_SNAPSHOT_TTL_MS : DONE_SNAPSHOT_TTL_MS;
  finishRun(taskId, ttl, runId);
}

async function streamChatTurn(
  runTask: Task,
  sessionId: string,
  content: string,
  options: { completeOnDone: boolean; captureResponseText?: boolean },
): Promise<StreamChatTurnResult> {
  let sawDone = false;
  let doneContext: ContextUsage | null | undefined;
  let responseText = '';
  let hadError = false;
  let interrupted = false;

  try {
    const streamOptions: AgentRunOptions = {
      systemMessage: TASK_AGENT_SYSTEM_PROMPT,
      settings: taskRunSettings(runTask),
      task: { id: runTask.id, title: runTask.title },
    };

    // Inject parent task context when this task is a delegated subissue
    if (runTask.parent_task_id) {
      const parentTask = getTask(runTask.parent_task_id);
      if (parentTask) {
        streamOptions.parentTask = {
          id: parentTask.id,
          title: parentTask.title,
          description: parentTask.description,
        };
        streamOptions.delegatedTaskId = runTask.id;
      }
    }

    const stream = adapter.chatStream(sessionId, content, streamOptions);

    for await (const event of stream) {
      if (options.captureResponseText && event.type === 'text_delta' && event.content) {
        responseText += event.content;
      }
      if (event.type === 'done') {
        sawDone = true;
        doneContext = event.context;
        if (event.interrupted) interrupted = true;
        if (!options.completeOnDone) {
          updateRunContext(runTask.id, event.context, event.sessionId);
          continue;
        }
      }
      if (event.type === 'error') {
        hadError = true;
      }
      applyEvent(runTask.id, event);
      broadcastLive(runTask.id, event);
    }
  } catch (error) {
    hadError = true;
    const event: StreamEvent = { type: 'error', error: toErrorMessage(error, 'Hermes chat stream failed') };
    applyEvent(runTask.id, event);
    broadcastLive(runTask.id, event);
  }

  const finalRun = getRunStatus(runTask.id);
  if (!sawDone && !hadError && finalRun?.status === 'streaming') {
    if (options.completeOnDone) {
      const event: StreamEvent = { type: 'done', sessionId, context: doneContext };
      sawDone = true;
      applyEvent(runTask.id, event);
      broadcastLive(runTask.id, event);
    } else {
      hadError = true;
      const event: StreamEvent = { type: 'error', error: 'Hermes chat stream ended before completion' };
      applyEvent(runTask.id, event);
      broadcastLive(runTask.id, event);
    }
  }

  return { responseText, sawDone, context: doneContext, hadError, interrupted };
}

async function consumeChatRun(runTask: Task, sessionId: string, content: string, runId: string): Promise<void> {
  const result = await streamChatTurn(runTask, sessionId, content, { completeOnDone: true });
  try {
    settleRun(runTask.id, runId, result.context ?? null);
  } catch {
    finishRun(runTask.id, ERROR_SNAPSHOT_TTL_MS, runId);
  }
}

async function consumeGoalRun(runTask: Task, sessionId: string, initialContent: string, runId: string): Promise<void> {
  let finalContext: ContextUsage | null | undefined;
  let hadError = false;
  let wasInterrupted = false;
  let turnContent: string | null = initialContent;
  let turnCount = 0;

  try {
    while (turnContent) {
      if (++turnCount > MINIONS_GOAL_MAX_TURNS) {
        appendSystemMessage(runTask.id, 'Goal turn limit reached');
        break;
      }
      appendUserMessage(runTask.id, turnContent);
      startAssistantMessage(runTask.id);

      const turn = await streamChatTurn(runTask, sessionId, turnContent, {
        completeOnDone: false,
        captureResponseText: true,
      });
      if (turn.context !== undefined) finalContext = turn.context;
      const currentRun = getRunStatus(runTask.id);
      if (turn.hadError || currentRun?.status === 'error') {
        hadError = true;
        break;
      }
      if (turn.interrupted) {
        wasInterrupted = true;
        break;
      }

      const decision = await adapter.evaluateGoal(sessionId, turn.responseText);
      let shouldBroadcastSnapshot = false;
      if (decision.state) {
        const goalRun = updateRunGoal(runTask.id, decision.state);
        if (goalRun) broadcast({ type: 'task_run_updated', run: goalRun });
        shouldBroadcastSnapshot = true;
      }
      if (decision.message) {
        appendSystemMessage(runTask.id, decision.message);
        shouldBroadcastSnapshot = true;
      }
      if (shouldBroadcastSnapshot) broadcastRunSnapshot(runTask.id);

      if (!decision.shouldContinue) break;

      turnContent = decision.continuationPrompt?.trim() ? decision.continuationPrompt : null;
    }
  } catch (error) {
    hadError = true;
    const event: StreamEvent = { type: 'error', error: toErrorMessage(error, 'Hermes goal loop failed') };
    applyEvent(runTask.id, event);
    broadcastLive(runTask.id, event);
  } finally {
    if (!hadError && getRunStatus(runTask.id)?.status === 'streaming') {
      updateRunStatus(runTask.id, wasInterrupted ? 'stopped' : 'done', { context: finalContext ?? null });
    }
    // Goal-turn `done` events are swallowed (completeOnDone=false), so the live
    // channel never sees the terminal status — push a final snapshot for it. The
    // error path already delivered a terminal `error` event, so skip it there.
    if (!hadError) broadcastRunSnapshot(runTask.id);
    settleRun(runTask.id, runId, finalContext ?? null);
  }
}

chatRouter.post('/:id/messages', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { content } = req.body;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }

  let runSettings: ReturnType<typeof parseRunSettingsBody>;
  let mode: ChatRunMode;
  try {
    runSettings = parseRunSettingsBody(req.body);
    mode = parseChatRunMode(req.body);
  } catch (error) {
    return res.status(400).json({ error: toErrorMessage(error, 'Invalid run settings') });
  }

  const activeRun = getRunStatus(task.id);
  if (isTaskRunActive(activeRun)) {
    return res.status(409).json({ error: 'This task already has a message in progress' });
  }

  let runTask = task;
  const taskUpdates: Partial<Pick<Task, 'status' | 'agent_model' | 'reasoning_effort'>> = {};
  if (runSettings.hasFields) {
    const { taskFields } = runSettings;
    if (taskFields.agent_model !== undefined && taskFields.agent_model !== task.agent_model) {
      taskUpdates.agent_model = taskFields.agent_model;
    }
    if (taskFields.reasoning_effort !== undefined && taskFields.reasoning_effort !== task.reasoning_effort) {
      taskUpdates.reasoning_effort = taskFields.reasoning_effort;
    }
  }
  if (task.status === 'in_review' || task.status === 'done') {
    taskUpdates.status = 'in_progress';
  }

  if (Object.keys(taskUpdates).length > 0) {
    const updated = updateTask(task.id, taskUpdates);
    if (!updated) return res.status(404).json({ error: 'Task not found' });
    runTask = updated;
    broadcast({ type: 'task_updated', task: updated });
  }

  const sessionId = runTask.id;

  if (mode === 'goal') {
    let goalState: GoalStateSnapshot;
    try {
      goalState = await adapter.setGoal(sessionId, content);
    } catch (error) {
      return res.status(503).json({ error: toErrorMessage(error, 'Could not set Hermes goal') });
    }

    const { snapshot, state } = startGoalRun(runTask.id, sessionId, goalState);
    broadcast({ type: 'task_run_updated', run: state });
    broadcastLive(runTask.id, { type: 'snapshot', run: snapshot });
    void consumeGoalRun(runTask, sessionId, content, snapshot.runId);

    return res.status(202).json({ runId: snapshot.runId });
  }

  const { snapshot, state } = startRun(runTask.id, sessionId, content);
  const delegatedRunTask = taskWithDelegationStatus(runTask, state);
  if (delegatedRunTask && delegatedRunTask !== runTask) {
    runTask = delegatedRunTask;
    broadcast({ type: 'task_updated', task: delegatedRunTask });
  }
  broadcast({ type: 'task_run_updated', run: state });
  broadcastLive(runTask.id, { type: 'snapshot', run: snapshot });
  void consumeChatRun(runTask, sessionId, content, snapshot.runId);

  res.status(202).json({ runId: snapshot.runId });
});

chatRouter.post('/:id/interrupt', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (!isInterruptibleRun(getRunStatus(task.id))) {
    return res.status(409).json({ error: 'This task has no active message to stop' });
  }

  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
    ? req.body.reason.trim()
    : undefined;

  try {
    const interrupted = await adapter.interruptChat(task.id, reason);
    if (!interrupted) {
      return res.status(409).json({ error: 'Hermes had no active agent to stop for this task' });
    }
    res.json({ interrupted: true });
  } catch (error) {
    res.status(503).json({ error: toErrorMessage(error, 'Could not stop Hermes run') });
  }
});

chatRouter.post('/:id/compact', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const activeRun = getRunStatus(task.id);
  if (isTaskRunActive(activeRun)) {
    return res.status(409).json({
      error: activeRun?.status === 'compacting'
        ? 'This task is already compacting'
        : 'Cannot compact while a message is streaming',
    });
  }

  const focusTopic = typeof req.body?.focusTopic === 'string' ? req.body.focusTopic.trim() || null : null;
  const currentTokens = task.last_context_used_tokens ?? undefined;
  const { snapshot, state } = startCompactionRun(task.id, task.id);
  broadcast({ type: 'task_run_updated', run: state });
  broadcastLive(task.id, { type: 'snapshot', run: snapshot });

  try {
    const result: CompactResult = await adapter.compressSession(task.id, {
      focusTopic,
      currentTokens,
      systemMessage: TASK_AGENT_SYSTEM_PROMPT,
      settings: taskRunSettings(task),
    });

    if (result.context) {
      const updated = recordAgentResponse(task.id, task.last_agent_response_at ?? Date.now(), result.context);
      if (updated) broadcast({ type: 'task_updated', task: updated });
    }

    completeTaskRun(task.id, snapshot.runId, 'done', DONE_SNAPSHOT_TTL_MS, { context: result.context });

    res.json(result);
  } catch (error) {
    const message = toErrorMessage(error, 'Compaction failed');
    completeTaskRun(task.id, snapshot.runId, 'error', ERROR_SNAPSHOT_TTL_MS, { error: message });
    res.status(503).json({ error: message });
  }
});

chatRouter.get('/:id/live', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  initSSE(res);
  subscribe(task.id, res);

  const run = getRun(task.id);
  if (run) sendSnapshot(res, run);
});
