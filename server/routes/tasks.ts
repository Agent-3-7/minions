import { Router } from 'express';
import { getAllTasks, getTask, insertTask, updateTask, deleteTask, markTaskViewed } from '../db/queries.js';
import { broadcast } from '../events.js';
import { TASK_STATUSES } from '../../shared/types.js';
import type { TaskStatus } from '../../shared/types.js';

export const tasksRouter = Router();

const LOW_INFORMATION_TITLES = new Set(['?', 'hi', 'hello', 'hey', 'yo']);

tasksRouter.get('/', (req, res) => {
  const status = req.query.status as TaskStatus | undefined;
  const tasks = getAllTasks(status);
  res.json({ tasks });
});

tasksRouter.get('/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task });
});

function generateTitle(text: string): string {
  const firstLine = text.split(/\n/)[0].trim();
  const normalizedFirstLine = firstLine.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/g, '').trim();
  if (!normalizedFirstLine || LOW_INFORMATION_TITLES.has(normalizedFirstLine)) return 'Untitled task';

  const firstSentence = firstLine.split(/[.!?]/)[0].trim();
  if (!firstSentence) return text.slice(0, 60).trim() || 'Untitled task';
  if (firstSentence.length <= 60) return firstSentence;
  return firstSentence.slice(0, 57) + '...';
}

tasksRouter.post('/', (req, res) => {
  const { description, title } = req.body;
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description is required' });
  }

  const resolvedTitle = title && typeof title === 'string' && title.trim()
    ? title.trim()
    : generateTitle(description);
  const task = insertTask({
    title: resolvedTitle,
    description,
    status: 'in_progress',
  });
  broadcast({ type: 'task_created', task });
  res.status(201).json({ task });
});

tasksRouter.patch('/:id', (req, res) => {
  const allowed = ['title', 'description', 'status'] as const;
  const fields: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) fields[key] = req.body[key];
  }

  if (fields.status && !TASK_STATUSES.includes(fields.status as TaskStatus)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  const updated = updateTask(req.params.id, fields);
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_updated', task: updated });
  res.json({ task: updated });
});

tasksRouter.post('/:id/viewed', (req, res) => {
  const { task, changed } = markTaskViewed(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (changed) broadcast({ type: 'task_updated', task });
  res.json({ task });
});

tasksRouter.delete('/:id', (req, res) => {
  const deleted = deleteTask(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_deleted', taskId: req.params.id });
  res.json({ ok: true });
});

tasksRouter.post('/:id/move', (req, res) => {
  const { status } = req.body;
  if (!TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  const updated = updateTask(req.params.id, { status });
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_updated', task: updated });
  res.json({ task: updated });
});
