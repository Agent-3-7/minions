import { Router } from 'express';
import { getAllTasks, getTask, insertTask, updateTask, deleteTask, markTaskViewed, getSubissues, getSubissueCount } from '../db/queries.js';
import { broadcast } from '../events.js';
import { adapter } from '../app.js';
import { startTaskChatRun } from './chat.js';
import { TASK_STATUSES, DELEGATION_STATUSES } from '../../shared/types.js';
import type { TaskStatus, DelegationStatus } from '../../shared/types.js';

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

async function enrichTaskTitle(taskId: string, fallbackTitle: string, description: string): Promise<void> {
  try {
    const { title } = await adapter.generateTitle(description);
    const cleaned = title.trim();
    if (!cleaned || cleaned === fallbackTitle) return;

    const current = getTask(taskId);
    if (!current || current.title !== fallbackTitle) return;

    const updated = updateTask(taskId, { title: cleaned });
    if (updated) broadcast({ type: 'task_updated', task: updated });
  } catch {
    // Best-effort: leave the fallback title in place if the LLM call fails.
  }
}

tasksRouter.post('/', (req, res) => {
  const { description, title } = req.body;
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description is required' });
  }

  const userTitle = typeof title === 'string' ? title.trim() : '';
  const resolvedTitle = userTitle || generateTitle(description);
  const task = insertTask({
    title: resolvedTitle,
    description,
    status: 'in_progress',
  });
  broadcast({ type: 'task_created', task });
  res.status(201).json({ task });

  if (!userTitle) {
    void enrichTaskTitle(task.id, resolvedTitle, description);
  }
});

tasksRouter.patch('/:id', (req, res) => {
  const allowed = ['title', 'description', 'status', 'priority', 'labels_json', 'assignee', 'delegation_status', 'parent_task_id', 'agent_model', 'reasoning_effort'] as const;
  const fields: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) fields[key] = req.body[key];
  }

  if (fields.status && !TASK_STATUSES.includes(fields.status as TaskStatus)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  if (fields.delegation_status && !DELEGATION_STATUSES.includes(fields.delegation_status as DelegationStatus)) {
    return res.status(400).json({ error: `delegation_status must be one of: ${DELEGATION_STATUSES.join(', ')}` });
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

// Milestone 3: Subissues
tasksRouter.get('/:id/subissues', (req, res) => {
  const parent = getTask(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Task not found' });

  const subissues = getSubissues(req.params.id);
  res.json({ parent, subissues });
});

tasksRouter.post('/:id/subissues', (req, res) => {
  const parent = getTask(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Task not found' });

  const { title, description, delegate, agent_model, reasoning_effort, priority, labels, assignee } = req.body;
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title is required' });
  }

  // If delegation requested and description not provided, use title as description
  const resolvedDescription = typeof description === 'string' ? description : title;
  const resolvedLabelsJson = Array.isArray(labels) ? JSON.stringify(labels) : null;

  const createdSubissue = insertTask({
    title,
    description: resolvedDescription,
    status: 'in_progress',
    parent_task_id: req.params.id,
    agent_model: agent_model ?? undefined,
    reasoning_effort: reasoning_effort ?? undefined,
    priority: typeof priority === 'number' ? priority : undefined,
    labels_json: resolvedLabelsJson,
    assignee: assignee ?? undefined,
    delegation_status: delegate ? 'queued' : undefined,
  });

  let subissue = createdSubissue;
  // Embed parent context in description for delegated subissues
  if (delegate && subissue) {
    const ctxSuffix = `\n\n---\n*Created from parent task: ${parent.title} (${parent.id})*`;
    const updatedSubissue = updateTask(subissue.id, { description: (subissue.description ?? '') + ctxSuffix });
    if (updatedSubissue) subissue = updatedSubissue;
  }

  broadcast({ type: 'task_created', task: subissue });

  let runId: string | null = null;
  if (delegate) {
    try {
      runId = startTaskChatRun(subissue, subissue.description ?? subissue.title).runId;
    } catch (error) {
      const blocked = updateTask(subissue.id, { delegation_status: 'blocked' });
      if (blocked) {
        subissue = blocked;
        broadcast({ type: 'task_updated', task: blocked });
      }
      return res.status(409).json({ error: error instanceof Error ? error.message : 'Could not start delegated subissue' });
    }
  }

  // Refresh parent broadcast with updated subissue count
  const updatedParent = getTask(req.params.id);
  if (updatedParent) broadcast({ type: 'task_updated', task: updatedParent });

  res.status(201).json({ parent: updatedParent ?? parent, subissues: getSubissues(req.params.id), runId });
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
