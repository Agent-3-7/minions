import { Router } from 'express';
import { getTask, updateTask , getAllTasks } from '../db/queries.js';
import { broadcast } from '../events.js';

export const githubWebhookRouter = Router();

/**
 * GitHub webhook endpoint.
 *
 * Accepts push, pull_request, and check_run events from GitHub.
 * Matches PRs to tasks by looking for the PR URL in task descriptions
 * (agents link them when creating PRs via GitHub PR workflow).
 *
 * Environment variable GITHUB_WEBHOOK_SECRET is optional but recommended
 * for production payload verification.
 */
githubWebhookRouter.post('/webhook', (req, res) => {
  const event = req.headers['x-github-event'] as string | undefined;
  const delivery = req.headers['x-github-delivery'] as string | undefined;

  // Respond immediately to acknowledge receipt
  res.status(202).json({ ok: true, event, delivery });

  // Fire-and-forget processing
  void handleEvent(event, req.body);
});

interface PullRequestPayload {
  action: string;
  number: number;
  pull_request: {
    html_url: string;
    state: string;
    merged: boolean;
    head: {
      ref: string;
      sha: string;
      repo?: { full_name?: string };
    };
    base: {
      ref: string;
      repo?: { full_name?: string };
    };
    title?: string;
    body?: string | null;
  };
  repository?: {
    full_name?: string;
    html_url?: string;
  };
}

interface CheckRunPayload {
  action: string;
  check_run: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    html_url?: string;
    head_sha: string;
    check_suite?: {
      head_sha?: string;
      head_branch?: string;
    };
    output?: {
      title?: string;
      summary?: string;
    };
  };
  repository?: {
    full_name?: string;
    html_url?: string;
  };
}

interface PushPayload {
  ref: string;
  head_commit?: {
    id: string;
    message: string;
  } | null;
  repository?: {
    full_name?: string;
    html_url?: string;
  };
}

function findTaskByPrUrl(prUrl: string) : { id: string } | undefined {
  const tasks = getAllTasks();
  const url = prUrl.replace(/\/+$/, '');
  return tasks.find(t => {
    if (t.github_pr_url && t.github_pr_url.replace(/\/+$/, '') === url) return true;
    // Also search description for the PR URL
    if (t.description && t.description.includes(url)) return true;
    return false;
  });
}

function findTaskByHeadSha(sha: string): { id: string } | undefined {
  const tasks = getAllTasks();
  return tasks.find(t => t.github_pr_head_sha === sha)
    ?? tasks.find(t => t.description && t.description.includes(sha));
}

function findTaskByBranch(branch: string): { id: string } | undefined {
  const tasks = getAllTasks();
  return tasks.find(t => t.github_pr_head_ref === branch);
}

async function handleEvent(event: string | undefined, payload: unknown): Promise<void> {
  try {
    if (event === 'pull_request') {
      await handlePullRequest(payload as PullRequestPayload);
    } else if (event === 'check_run') {
      await handleCheckRun(payload as CheckRunPayload);
    } else if (event === 'push') {
      await handlePush(payload as PushPayload);
    }
    // Other events (ping, etc.) are silently ignored
  } catch (err) {
    console.error('[github-webhook] Error processing event:', err);
  }
}

async function handlePullRequest(payload: PullRequestPayload): Promise<void> {
  const pr = payload.pull_request;
  const prUrl = pr.html_url;
  const action = payload.action;

  const task = findTaskByPrUrl(prUrl);
  if (!task) {
    // No task matched — PR might have been created manually without a linked task
    return;
  }

  const updates: Record<string, unknown> = {
    github_pr_url: prUrl,
    github_pr_number: payload.number,
    github_pr_state: pr.merged ? 'merged' : pr.state,
    github_pr_head_ref: pr.head.ref,
    github_pr_head_sha: pr.head.sha,
  };

  const updated = updateTask(task.id, updates);
  if (updated) {
    broadcast({ type: 'task_updated', task: updated });
  }
}

async function handleCheckRun(payload: CheckRunPayload): Promise<void> {
  const check = payload.check_run;
  if (check.status === 'queued') return; // No useful info yet

  const task = findTaskByHeadSha(check.head_sha)
    ?? findTaskByBranch(check.check_suite?.head_branch ?? '');

  if (!task) return;

  // Aggregate checks: find all tasks with this SHA and compute status
  const conclusion = check.conclusion ?? 'pending';

  // Determine overall status
  const tasks = getAllTasks();
  const match = tasks.find(t => t.id === task.id);
  if (!match) return;

  const currentConclusion = match.github_checks_status;
  let overallStatus: string;

  if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') {
    overallStatus = 'failure';
  } else if (conclusion === 'success') {
    // Only success if everything we know is success
    overallStatus = currentConclusion === 'failure' ? 'failure' : 'success';
  } else if (conclusion === 'neutral' || conclusion === 'skipped') {
    overallStatus = currentConclusion ?? 'success';
  } else {
    overallStatus = 'pending';
  }

  const summary = check.output?.summary
    ? check.output.summary.slice(0, 2000)
    : check.conclusion
      ? `Check "${check.name}": ${check.conclusion}`
      : `Check "${check.name}": ${check.status}`;

  const updated = updateTask(task.id, {
    github_checks_status: overallStatus,
    github_checks_summary: summary,
    github_checks_updated_at: Date.now(),
  });
  if (updated) {
    broadcast({ type: 'task_updated', task: updated });
  }
}

async function handlePush(payload: PushPayload): Promise<void> {
  // Extract branch from ref (refs/heads/branch-name)
  const ref = payload.ref ?? '';
  if (!ref.startsWith('refs/heads/')) return;
  const branch = ref.slice('refs/heads/'.length);

  const headSha = payload.head_commit?.id;

  const task = findTaskByBranch(branch)
    ?? (headSha ? findTaskByHeadSha(headSha) : undefined);

  if (!task || !headSha) return;

  const updated = updateTask(task.id, {
    github_pr_head_sha: headSha,
  });
  if (updated) {
    broadcast({ type: 'task_updated', task: updated });
  }
}

// Also export a helper for the app to register
export function registerGithubWebhookRoutes(router: Router): void {
  router.use('/api/github', githubWebhookRouter);
}
