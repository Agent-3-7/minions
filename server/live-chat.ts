import type { Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { GoalStateSnapshot, LiveChatRun, LiveChatMessage, LiveChatRunStatus, TaskRunState, ToolProgressEvent } from '../shared/types.js';
import type { StreamEvent } from './adapters/types.js';

export type LiveChatEvent = StreamEvent | { type: 'snapshot'; run: LiveChatRun };

const runs = new Map<string, LiveChatRun>();
const subscribers = new Map<string, Set<Response>>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

const KEEPALIVE_INTERVAL_MS = 30_000;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function cloneRun(run: LiveChatRun): LiveChatRun {
  return {
    ...run,
    messages: run.messages.map((message) => ({
      ...message,
      tools: message.tools ? message.tools.map((tool) => ({ ...tool })) : undefined,
    })),
    goal: run.goal ? { ...run.goal } : null,
    context: run.context ? { ...run.context } : null,
  };
}

function runState(run: LiveChatRun): TaskRunState {
  return {
    taskId: run.taskId,
    runId: run.runId,
    kind: run.kind,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    goal: run.goal ? { ...run.goal } : null,
  };
}

function assistantMessage(run: LiveChatRun): LiveChatMessage {
  for (let i = run.messages.length - 1; i >= 0; i--) {
    if (run.messages[i].role === 'assistant') return run.messages[i];
  }

  const message: LiveChatMessage = {
    id: uuid(),
    task_id: run.taskId,
    role: 'assistant',
    content: '',
    created_at: Date.now(),
  };
  run.messages.push(message);
  return message;
}

function mergeToolProgress(tools: ToolProgressEvent[], event: StreamEvent): void {
  const tool: ToolProgressEvent = {
    tool: event.tool ?? 'tool',
    status: event.status ?? 'running',
    duration: event.duration,
    label: event.label,
    codeDiff: event.codeDiff ?? null,
  };

  if (tool.status === 'running') {
    tools.push(tool);
    return;
  }

  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].tool === tool.tool && tools[i].status === 'running') {
      tools[i] = { ...tools[i], ...tool, label: tool.label ?? tools[i].label, codeDiff: tool.codeDiff ?? tools[i].codeDiff };
      return;
    }
  }

  tools.push(tool);
}

function writeEvent(res: Response, event: LiveChatEvent): boolean {
  try {
    return res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    return false;
  }
}

function startKeepalive(): void {
  if (keepaliveTimer) return;

  keepaliveTimer = setInterval(() => {
    for (const [taskId, taskSubscribers] of subscribers) {
      for (const subscriber of taskSubscribers) {
        try {
          subscriber.write(':keepalive\n\n');
        } catch {
          taskSubscribers.delete(subscriber);
        }
      }
      if (taskSubscribers.size === 0) subscribers.delete(taskId);
    }

    if (subscribers.size === 0 && keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function clearExpiry(taskId: string): void {
  const timer = expiryTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(taskId);
  }
}

export type RunStart = { snapshot: LiveChatRun; state: TaskRunState };

function storeRun(run: LiveChatRun): RunStart {
  runs.set(run.taskId, run);
  return { snapshot: cloneRun(run), state: runState(run) };
}

export function startRun(taskId: string, sessionId: string, userContent: string): RunStart {
  clearExpiry(taskId);
  const now = Date.now();
  return storeRun({
    taskId,
    runId: uuid(),
    kind: 'chat',
    sessionId,
    status: 'streaming',
    startedAt: now,
    updatedAt: now,
    messages: [
      { id: uuid(), task_id: taskId, role: 'user', content: userContent, created_at: now },
      { id: uuid(), task_id: taskId, role: 'assistant', content: '', created_at: now, tools: [] },
    ],
  });
}

export function startGoalRun(taskId: string, sessionId: string, goal?: GoalStateSnapshot | null): RunStart {
  clearExpiry(taskId);
  const now = Date.now();
  return storeRun({
    taskId,
    runId: uuid(),
    kind: 'goal',
    sessionId,
    status: 'streaming',
    startedAt: now,
    updatedAt: now,
    messages: [],
    goal: goal ? { ...goal } : null,
  });
}

export function startCompactionRun(taskId: string, sessionId: string): RunStart {
  clearExpiry(taskId);
  const now = Date.now();
  return storeRun({
    taskId,
    runId: uuid(),
    kind: 'compact',
    sessionId,
    status: 'compacting',
    startedAt: now,
    updatedAt: now,
    messages: [],
  });
}

function appendMessage(
  taskId: string,
  role: LiveChatMessage['role'],
  content: string,
  extra?: Partial<LiveChatMessage>,
): void {
  const run = runs.get(taskId);
  if (!run) return;
  const now = Date.now();
  run.messages.push({ id: uuid(), task_id: taskId, role, content, created_at: now, ...extra });
  run.updatedAt = now;
}

export function appendUserMessage(taskId: string, content: string): void {
  appendMessage(taskId, 'user', content);
}

export function appendSystemMessage(taskId: string, content: string): void {
  appendMessage(taskId, 'system', content);
}

export function startAssistantMessage(taskId: string): void {
  appendMessage(taskId, 'assistant', '', { tools: [] });
}

export function updateRunContext(
  taskId: string,
  context: LiveChatRun['context'],
  sessionId?: string,
): TaskRunState | undefined {
  const run = runs.get(taskId);
  if (!run) return undefined;
  if (sessionId) run.sessionId = sessionId;
  if (context !== undefined) run.context = context;
  run.updatedAt = Date.now();
  return runState(run);
}

export function updateRunGoal(taskId: string, goal: GoalStateSnapshot | null): TaskRunState | undefined {
  const run = runs.get(taskId);
  if (!run) return undefined;
  run.goal = goal ? { ...goal } : null;
  run.updatedAt = Date.now();
  return runState(run);
}

export function applyEvent(taskId: string, event: StreamEvent): void {
  const run = runs.get(taskId);
  if (!run) return;

  const assistant = assistantMessage(run);

  if (event.type === 'text_delta' && event.content) {
    assistant.content += event.content;
  } else if (event.type === 'thinking_delta' && event.content) {
    assistant.thinking = `${assistant.thinking ?? ''}${event.content}`;
  } else if (event.type === 'tool_progress') {
    if (!assistant.tools) assistant.tools = [];
    mergeToolProgress(assistant.tools, event);
  } else if (event.type === 'done') {
    if (run.status !== 'error') run.status = event.interrupted ? 'stopped' : 'done';
    if (event.sessionId) run.sessionId = event.sessionId;
    if (event.context !== undefined) {
      run.context = event.context;
    }
  } else if (event.type === 'error') {
    const error = event.error || 'Unknown error';
    run.status = 'error';
    run.error = error;
    if (!assistant.content.includes(`[Error: ${error}]`)) {
      assistant.content = assistant.content
        ? `${assistant.content}\n[Error: ${error}]`
        : `[Error: ${error}]`;
    }
  }

  run.updatedAt = Date.now();
}

export function getRun(taskId: string): LiveChatRun | undefined {
  const run = runs.get(taskId);
  return run ? cloneRun(run) : undefined;
}

export function getRunContext(taskId: string): LiveChatRun['context'] | undefined {
  return runs.get(taskId)?.context;
}

export function getRunStatus(taskId: string): TaskRunState | undefined {
  const run = runs.get(taskId);
  return run ? runState(run) : undefined;
}

export function getRunStatuses(): TaskRunState[] {
  return Array.from(runs.values()).map(runState);
}

export function updateRunStatus(
  taskId: string,
  status: Extract<LiveChatRunStatus, 'done' | 'error' | 'stopped'>,
  options?: { context?: LiveChatRun['context']; error?: string },
): TaskRunState | undefined {
  const run = runs.get(taskId);
  if (!run) return undefined;

  run.status = status;
  run.updatedAt = Date.now();
  if (options?.context !== undefined) run.context = options.context;
  if (options?.error) run.error = options.error;
  return runState(run);
}

export function subscribe(taskId: string, res: Response): void {
  let taskSubscribers = subscribers.get(taskId);
  if (!taskSubscribers) {
    taskSubscribers = new Set<Response>();
    subscribers.set(taskId, taskSubscribers);
  }

  taskSubscribers.add(res);
  res.on('close', () => {
    taskSubscribers.delete(res);
    if (taskSubscribers.size === 0) subscribers.delete(taskId);
  });
  startKeepalive();
}

export function sendSnapshot(res: Response, run: LiveChatRun): void {
  writeEvent(res, { type: 'snapshot', run });
}

export function broadcast(taskId: string, event: LiveChatEvent): void {
  const taskSubscribers = subscribers.get(taskId);
  if (!taskSubscribers) return;

  for (const subscriber of taskSubscribers) {
    if (!writeEvent(subscriber, event)) taskSubscribers.delete(subscriber);
  }

  if (taskSubscribers.size === 0) subscribers.delete(taskId);
}

export function finishRun(taskId: string, ttlMs: number, runId: string): void {
  if (!runs.has(taskId)) return;
  clearExpiry(taskId);

  const timer = setTimeout(() => {
    if (runs.get(taskId)?.runId === runId) runs.delete(taskId);
    expiryTimers.delete(taskId);
  }, ttlMs);
  timer.unref();
  expiryTimers.set(taskId, timer);
}
