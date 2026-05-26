import { Router, type Response } from 'express';
import { errorCode, isRecord, toErrorMessage } from '../errors.js';
import type { ScheduledTask, ScheduledTaskInput } from '../../shared/types.js';
import type { HermesWorkerAdapter } from '../adapters/hermes-worker.js';
import { listScheduledTaskRuns, getScheduledTaskRunContent } from '../scheduled-tasks/runs.js';

const SCHEDULED_TASKS_LIMIT = 100;
const SCHEDULED_TASK_RUNS_LIMIT = 50;

const SCHEDULED_TASK_INPUT_FIELDS = [
  'name',
  'prompt',
  'schedule',
  'deliver',
  'skills',
  'model',
  'provider',
  'baseUrl',
  'workdir',
  'repeat',
  'contextFrom',
] as const;

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function scheduledTaskInputFromBody(body: unknown): Partial<ScheduledTaskInput> {
  if (!isRecord(body)) return {};

  const input: Partial<ScheduledTaskInput> = {};
  for (const field of SCHEDULED_TASK_INPUT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      Object.assign(input, { [field]: body[field] });
    }
  }
  return input;
}

function workerStatus(error: unknown): number {
  const code = errorCode(error);
  if (code === 'bad_request') return 400;
  if (code === 'not_found') return 404;
  return 503;
}

function workerErrorFallback(error: unknown): string {
  return workerStatus(error) === 400 ? 'Invalid scheduled task' : 'Hermes scheduled tasks worker unavailable';
}

export function createScheduledTasksRouter(adapter: HermesWorkerAdapter): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const includeDisabled = req.query.includeDisabled === 'true';
      const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const parsedLimit = rawLimit ? Number.parseInt(String(rawLimit), 10) : SCHEDULED_TASKS_LIMIT;
      const limit = Number.isFinite(parsedLimit) ? parsedLimit : SCHEDULED_TASKS_LIMIT;
      const scheduledTasks = await adapter.listScheduledTasks(includeDisabled, limit);
      res.json({ scheduledTasks });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes scheduled tasks worker unavailable') });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const scheduledTask = await adapter.getScheduledTask(req.params.id);
      if (!scheduledTask) return res.status(404).json({ error: 'Scheduled task not found' });
      res.json({ scheduledTask });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes scheduled tasks worker unavailable') });
    }
  });

  router.post('/', async (req, res) => {
    const input = scheduledTaskInputFromBody(req.body);
    if (!hasText(input.prompt)) return res.status(400).json({ error: 'prompt is required' });
    if (!hasText(input.schedule)) return res.status(400).json({ error: 'schedule is required' });

    try {
      const scheduledTask = await adapter.createScheduledTask(input as ScheduledTaskInput);
      res.json({ scheduledTask });
    } catch (error) {
      const status = workerStatus(error);
      res.status(status).json({ error: toErrorMessage(error, workerErrorFallback(error)) });
    }
  });

  router.patch('/:id', async (req, res) => {
    const updates = scheduledTaskInputFromBody(req.body);
    if ('prompt' in updates && !hasText(updates.prompt)) {
      return res.status(400).json({ error: 'prompt cannot be empty' });
    }
    if ('schedule' in updates && !hasText(updates.schedule)) {
      return res.status(400).json({ error: 'schedule cannot be empty' });
    }

    try {
      const scheduledTask = await adapter.updateScheduledTask(req.params.id, updates);
      if (!scheduledTask) return res.status(404).json({ error: 'Scheduled task not found' });
      res.json({ scheduledTask });
    } catch (error) {
      const status = workerStatus(error);
      res.status(status).json({ error: toErrorMessage(error, workerErrorFallback(error)) });
    }
  });

  router.get('/:id/runs', async (req, res) => {
    try {
      const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const limit = rawLimit ? Number.parseInt(String(rawLimit), 10) : SCHEDULED_TASK_RUNS_LIMIT;
      const runs = await listScheduledTaskRuns(req.params.id, Number.isFinite(limit) ? limit : SCHEDULED_TASK_RUNS_LIMIT);
      res.json({ runs });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error, 'Failed to list scheduled task runs') });
    }
  });

  router.get('/:id/runs/:runId/content', async (req, res) => {
    try {
      const content = await getScheduledTaskRunContent(req.params.id, req.params.runId);
      if (!content) return res.status(404).json({ error: 'Scheduled task run output not found' });
      res.json({ content });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error, 'Failed to read scheduled task run') });
    }
  });

  async function scheduledTaskActionHandler(
    res: Response,
    id: string,
    action: (id: string) => Promise<ScheduledTask | null>,
  ) {
    try {
      const scheduledTask = await action(id);
      if (!scheduledTask) return res.status(404).json({ error: 'Scheduled task not found' });
      res.json({ scheduledTask });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes scheduled tasks worker unavailable') });
    }
  }

  router.post('/:id/pause', (req, res) => {
    const rawReason = req.body?.reason;
    const reason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : undefined;
    scheduledTaskActionHandler(res, req.params.id, (id) => adapter.pauseScheduledTask(id, reason));
  });

  router.post('/:id/resume', (req, res) => {
    scheduledTaskActionHandler(res, req.params.id, (id) => adapter.resumeScheduledTask(id));
  });

  router.post('/:id/run', (req, res) => {
    scheduledTaskActionHandler(res, req.params.id, (id) => adapter.runScheduledTask(id));
  });

  router.delete('/:id', async (req, res) => {
    try {
      const removed = await adapter.removeScheduledTask(req.params.id);
      if (!removed) return res.status(404).json({ error: 'Scheduled task not found' });
      res.json({ ok: true });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes scheduled tasks worker unavailable') });
    }
  });

  return router;
}
