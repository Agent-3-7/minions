import { Router } from 'express';
import { getTask, getTaskByKanbanId } from '../db/queries.js';
import { syncKanbanChildrenForTask } from '../services/kanban-bridge.js';

export const integrationsRouter = Router();

/**
 * POST /api/integrations/hermes/kanban-sync
 *
 * Triggered by Hermes plugin/webhook or cron when Kanban state changes.
 * Accepts optional taskId or kanbanTaskId to scope the sync.
 *
 * Body: { taskId?: string; kanbanTaskId?: string }
 *
 * When both are omitted, returns 400 — use the per-task sync endpoint instead.
 */
integrationsRouter.post('/hermes/kanban-sync', (req, res) => {
  const { taskId, kanbanTaskId } = req.body ?? {};

  if (taskId) {
    // Targeted sync by AgentControl task id
    const task = getTask(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    try {
      const result = syncKanbanChildrenForTask(task);
      return res.json({ synced: true, imported: result.imported, updated: result.updated });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Sync failed' });
    }
  }

  if (kanbanTaskId) {
    // Sync by Kanban task id — find the matching AgentControl task
    const existing = getTaskByKanbanId(kanbanTaskId);
    if (existing) {
      try {
        const result = syncKanbanChildrenForTask(existing);
        return res.json({ synced: true, imported: result.imported, updated: result.updated });
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : 'Sync failed' });
      }
    }
    return res.status(404).json({ error: 'No AgentControl task mapped to this Kanban task id' });
  }

  return res.status(400).json({ error: 'Provide taskId or kanbanTaskId' });
});
