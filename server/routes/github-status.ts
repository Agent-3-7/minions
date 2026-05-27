/**
 * GitHub PR + check status API endpoints for tasks.
 *
 * GET  /api/tasks/:id/github  — read current stored GitHub status
 * POST /api/tasks/:id/github/refresh — fetch fresh status from GitHub
 */

import { Router } from 'express';
import { getTask } from '../db/queries.js';
import { refreshTaskGitHubStatus } from '../services/github-status.js';
import type { Task } from '../../shared/types.js';

export const githubStatusRouter = Router({ mergeParams: true });

/**
 * GET /api/tasks/:id/github
 */
githubStatusRouter.get('/:id/github', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  res.json({
    taskId: task.id,
    github_pr_url: task.github_pr_url,
    github_pr_number: task.github_pr_number,
    github_pr_state: task.github_pr_state,
    github_pr_head_ref: task.github_pr_head_ref,
    github_pr_head_sha: task.github_pr_head_sha,
    github_checks_status: task.github_checks_status,
    github_checks_summary: task.github_checks_summary,
    github_checks_updated_at: task.github_checks_updated_at,
  });
});

/**
 * POST /api/tasks/:id/github/refresh
 */
githubStatusRouter.post('/:id/github/refresh', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }

  try {
    const updated = await refreshTaskGitHubStatus(task);

    if (!updated) {
      return res.json({
        taskId: task.id,
        refreshed: false,
        note: 'No PR URL found or fetch failed',
        github_pr_url: task.github_pr_url,
        github_pr_number: task.github_pr_number,
        github_pr_state: task.github_pr_state,
        github_pr_head_ref: task.github_pr_head_ref,
        github_pr_head_sha: task.github_pr_head_sha,
        github_checks_status: task.github_checks_status ?? 'unknown',
        github_checks_summary: task.github_checks_summary ?? null,
        github_checks_updated_at: task.github_checks_updated_at,
      });
    }

    res.json({
      taskId: updated.id,
      refreshed: true,
      github_pr_url: updated.github_pr_url,
      github_pr_number: updated.github_pr_number,
      github_pr_state: updated.github_pr_state,
      github_pr_head_ref: updated.github_pr_head_ref,
      github_pr_head_sha: updated.github_pr_head_sha,
      github_checks_status: updated.github_checks_status,
      github_checks_summary: updated.github_checks_summary,
      github_checks_updated_at: updated.github_checks_updated_at,
    });
  } catch (err: unknown) {
    console.error('[github-status] Refresh error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'GitHub refresh failed',
      github_checks_status: 'unknown',
    });
  }
});
