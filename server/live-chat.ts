import type { Response } from 'express';
import { v4 as uuid } from 'uuid';
import type { LiveChatRun, LiveChatMessage, TaskRunState, ToolProgressEvent } from '../shared/types.js';
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
      usage: message.usage ? { ...message.usage } : undefined,
    })),
    usage: run.usage ? { ...run.usage } : undefined,
  };
}

function runState(run: LiveChatRun): TaskRunState {
  return {
    taskId: run.taskId,
    runId: run.runId,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
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
  };

  if (tool.status === 'running') {
    tools.push(tool);
    return;
  }

  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].tool === tool.tool && tools[i].status === 'running') {
      tools[i] = { ...tools[i], ...tool, label: tool.label ?? tools[i].label };
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

export function startRun(taskId: string, sessionId: string, userContent: string): LiveChatRun {
  const expiryTimer = expiryTimers.get(taskId);
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimers.delete(taskId);
  }

  const now = Date.now();
  const run: LiveChatRun = {
    taskId,
    runId: uuid(),
    sessionId,
    status: 'streaming',
    startedAt: now,
    updatedAt: now,
    messages: [
      {
        id: uuid(),
        task_id: taskId,
        role: 'user',
        content: userContent,
        created_at: now,
      },
      {
        id: uuid(),
        task_id: taskId,
        role: 'assistant',
        content: '',
        created_at: now,
        tools: [],
      },
    ],
  };

  runs.set(taskId, run);
  return cloneRun(run);
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
    if (run.status !== 'error') run.status = 'done';
    if (event.sessionId) run.sessionId = event.sessionId;
    if (event.usage) {
      run.usage = event.usage;
      assistant.usage = event.usage;
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

export function getRunUsage(taskId: string): LiveChatRun['usage'] | undefined {
  return runs.get(taskId)?.usage;
}

export function getRunStatus(taskId: string): TaskRunState | undefined {
  const run = runs.get(taskId);
  return run ? runState(run) : undefined;
}

export function getRunStatuses(): TaskRunState[] {
  return Array.from(runs.values()).map(runState);
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

  const expiryTimer = expiryTimers.get(taskId);
  if (expiryTimer) clearTimeout(expiryTimer);

  const timer = setTimeout(() => {
    if (runs.get(taskId)?.runId === runId) runs.delete(taskId);
    expiryTimers.delete(taskId);
  }, ttlMs);
  timer.unref();
  expiryTimers.set(taskId, timer);
}
