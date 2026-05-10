import { Router } from 'express';
import { getTask, updateTask, touchTask, recordAgentResponse, usageFromTask } from '../db/queries.js';
import { adapter } from '../app.js';
import { broadcast, initSSE } from '../events.js';
import {
  applyEvent,
  broadcast as broadcastLive,
  finishRun,
  getRun,
  getRunStatus,
  getRunUsage,
  sendSnapshot,
  startRun,
  subscribe,
} from '../live-chat.js';
import { taskRunSettings, parseRunSettingsBody } from '../agent-settings.js';
import { TASK_AGENT_SYSTEM_PROMPT } from '../prompts/task-agent.js';
import { toErrorMessage } from '../errors.js';
import type { StreamEvent } from '../adapters/types.js';
import type { Task, UsageStats } from '../../shared/types.js';

export const chatRouter = Router();

function hasNoSession(task: Task): boolean {
  if (task.last_agent_response_at !== null) return false;
  return getRunStatus(task.id)?.status !== 'streaming';
}

chatRouter.get('/:id/messages', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const usage = getRunUsage(task.id) ?? usageFromTask(task);
  if (hasNoSession(task)) return res.json({ messages: [], usage });

  try {
    const messages = await adapter.getMessages(task.id, task.id);
    res.json({ messages, usage });
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
const ERROR_SNAPSHOT_TTL_MS = 5 * 60_000;

async function consumeChatRun(runTask: Task, sessionId: string, content: string, runId: string): Promise<void> {
  let sawDone = false;
  let doneUsage: UsageStats | undefined;

  try {
    const stream = adapter.chatStream(sessionId, content, {
      systemMessage: TASK_AGENT_SYSTEM_PROMPT,
      settings: taskRunSettings(runTask),
      task: { id: runTask.id, title: runTask.title },
    });

    for await (const event of stream) {
      if (event.type === 'done') {
        sawDone = true;
        doneUsage = event.usage;
      }
      applyEvent(runTask.id, event);
      broadcastLive(runTask.id, event);
    }
  } catch (error) {
    const event: StreamEvent = { type: 'error', error: toErrorMessage(error, 'Hermes chat stream failed') };
    applyEvent(runTask.id, event);
    broadcastLive(runTask.id, event);
  } finally {
    const currentRun = getRunStatus(runTask.id);
    if (!sawDone && currentRun?.status === 'streaming') {
      const event: StreamEvent = { type: 'done', sessionId };
      sawDone = true;
      applyEvent(runTask.id, event);
      broadcastLive(runTask.id, event);
    }

    const finishedRun = getRunStatus(runTask.id);
    if (sawDone && finishedRun?.status === 'done') {
      const updated = recordAgentResponse(runTask.id, Date.now(), doneUsage ?? null);
      if (updated) broadcast({ type: 'task_updated', task: updated });
    } else {
      touchTask(runTask.id);
    }

    const ttl = finishedRun?.status === 'error' ? ERROR_SNAPSHOT_TTL_MS : DONE_SNAPSHOT_TTL_MS;
    finishRun(runTask.id, ttl, runId);
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
  try {
    runSettings = parseRunSettingsBody(req.body);
  } catch (error) {
    return res.status(400).json({ error: toErrorMessage(error, 'Invalid run settings') });
  }

  const activeRun = getRunStatus(task.id);
  if (activeRun?.status === 'streaming') {
    return res.status(409).json({ error: 'This task already has a message in progress' });
  }

  let runTask = task;
  if (runSettings.hasFields) {
    const { taskFields } = runSettings;
    const changed =
      (taskFields.agent_model !== undefined && taskFields.agent_model !== task.agent_model) ||
      (taskFields.reasoning_effort !== undefined && taskFields.reasoning_effort !== task.reasoning_effort);
    if (changed) {
      const updated = updateTask(task.id, taskFields);
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      runTask = updated;
      broadcast({ type: 'task_updated', task: updated });
    }
  }

  const sessionId = runTask.id;

  const run = startRun(runTask.id, sessionId, content);
  broadcastLive(runTask.id, { type: 'snapshot', run });
  void consumeChatRun(runTask, sessionId, content, run.runId);

  res.status(202).json({ runId: run.runId, run });
});

chatRouter.get('/:id/live', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  initSSE(res);
  subscribe(task.id, res);

  const run = getRun(task.id);
  if (run) sendSnapshot(res, run);
});
