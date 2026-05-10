import type { AgentAdapter } from '../adapters/types.js';
import type { Task, TaskStatus, HeartbeatLogEntry } from '../../shared/types.js';
import * as queries from '../db/queries.js';
import { broadcast } from '../events.js';
import { toErrorMessage, errorCode } from '../errors.js';
import { taskRunSettings } from '../agent-settings.js';
import { buildCheckinPrompt, parseStatusResponse } from '../prompts/heartbeat.js';

const AGENT_RUN_LIMIT = parseInt(process.env.HERMES_AGENT_RUN_LIMIT ?? '10', 10);
const RESERVED_INTERACTIVE_RUNS = 1;
const HEARTBEAT_CONCURRENCY = Math.min(
  parseInt(process.env.HEARTBEAT_CONCURRENCY ?? '2', 10),
  Math.max(1, AGENT_RUN_LIMIT - RESERVED_INTERACTIVE_RUNS),
);
const HEARTBEAT_TASK_TIMEOUT_MS = 120_000;
const STATUS_TRANSITIONS: Record<string, { action: HeartbeatLogEntry['action']; taskStatus: TaskStatus }> = {
  completed: { action: 'move_in_review', taskStatus: 'in_review' },
  blocked: { action: 'move_blocked', taskStatus: 'blocked' },
};

let lastRunAt: number | null = null;
let isRunning = false;

export function getHeartbeatStatus() {
  return { lastRun: lastRunAt, isRunning };
}

export async function runHeartbeat(adapter: AgentAdapter): Promise<boolean> {
  if (isRunning) return false;
  isRunning = true;

  try {
    const settings = queries.getHeartbeatSettings();
    const idleCutoff = Date.now() - settings.idleMinutes * 60_000;
    const tasks = queries.getAllTasks('in_progress').filter((t) => {
      const lastActivity = t.last_agent_response_at ?? t.created_at;
      return lastActivity <= idleCutoff;
    });
    const now = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'long' });
    console.log(`[heartbeat] ${now} — checking ${tasks.length} in-progress tasks`);

    for (let i = 0; i < tasks.length; i += HEARTBEAT_CONCURRENCY) {
      const batch = tasks.slice(i, i + HEARTBEAT_CONCURRENCY);
      await Promise.allSettled(
        batch.map((task) => checkTaskWithTimeout(task, adapter)),
      );
    }

    lastRunAt = Date.now();
    console.log(`[heartbeat] done`);
    return true;
  } finally {
    isRunning = false;
  }
}

function isTaskBusyError(error: unknown): boolean {
  return errorCode(error) === 'task_busy';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(Object.assign(new Error(message), { code: 'heartbeat_timeout' }));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function checkTaskWithTimeout(task: Task, adapter: AgentAdapter): Promise<void> {
  try {
    await checkTask(task, adapter);
  } catch (err) {
    if (isTaskBusyError(err)) {
      console.log(`[heartbeat] skipped task ${task.id}: task already has an active agent run`);
      queries.insertHeartbeatLog(task.id, 'check', { result: 'skipped_busy' });
      return;
    }

    console.error(`[heartbeat] error checking task ${task.id}:`, err);
    queries.insertHeartbeatLog(task.id, 'check', { error: toErrorMessage(err), code: errorCode(err) });
  }
}

function broadcastAgentResponse(taskId: string, at: number) {
  const updated = queries.recordAgentResponse(taskId, at);
  if (updated) broadcast({ type: 'task_updated', task: updated });
}

async function checkTask(task: Task, adapter: AgentAdapter): Promise<void> {
  const recentLogs = queries.getHeartbeatLogs(task.id, 3);
  const prompt = buildCheckinPrompt(recentLogs);
  const { text: response } = await withTimeout(
    adapter.chat(task.id, prompt, {
      settings: taskRunSettings(task),
      task: { id: task.id, title: task.title },
    }),
    HEARTBEAT_TASK_TIMEOUT_MS,
    `heartbeat check timed out after ${HEARTBEAT_TASK_TIMEOUT_MS}ms`,
  );
  const responseAt = Date.now();
  const status = parseStatusResponse(response);

  if (!status) {
    queries.insertHeartbeatLog(task.id, 'check', { result: 'unparseable_response', raw: response.slice(0, 500) });
    broadcastAgentResponse(task.id, responseAt);
    return;
  }

  const transition = STATUS_TRANSITIONS[status.status];
  queries.insertHeartbeatLog(task.id, transition?.action ?? 'check', {
    status: status.status,
    summary: status.summary,
    user_summary: status.user_summary,
  });

  if (transition) {
    const updated = queries.updateTask(task.id, {
      status: transition.taskStatus,
      last_agent_response_at: responseAt,
    });
    if (updated) broadcast({ type: 'task_updated', task: updated });
  } else {
    broadcastAgentResponse(task.id, responseAt);
  }
}
