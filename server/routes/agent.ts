import { Router } from 'express';
import { getTask, getSubissues } from '../db/queries.js';
import { isRecord, toErrorMessage } from '../errors.js';
import { taskRunSettings } from '../agent-settings.js';
import { REASONING_EFFORTS } from '../../shared/types.js';
import type { AgentDefaults, Task, TaskAgentSettings, ReasoningEffort } from '../../shared/types.js';
import type { HermesWorkerAdapter } from '../adapters/hermes-worker.js';

const FALLBACK_DEFAULTS: AgentDefaults = {
  provider: null,
  model: null,
  baseUrl: null,
  apiMode: null,
  reasoningEffort: 'medium',
  showReasoning: true,
};

async function defaultsForSettings(adapter: HermesWorkerAdapter): Promise<AgentDefaults> {
  try {
    return await adapter.getDefaults();
  } catch {
    return FALLBACK_DEFAULTS;
  }
}

function buildTaskSettings(task: Task, defaults: AgentDefaults): TaskAgentSettings {
  const overrides = taskRunSettings(task);
  return {
    task: {
      model: overrides.model ?? null,
      provider: overrides.provider ?? null,
      reasoningEffort: overrides.reasoningEffort ?? null,
    },
    defaults,
    effective: {
      model: overrides.model ?? defaults.model,
      provider: overrides.provider ?? defaults.provider,
      reasoningEffort: overrides.reasoningEffort ?? defaults.reasoningEffort,
    },
  };
}

export function createAgentRouter(adapter: HermesWorkerAdapter): Router {
  const router = Router();

  router.get('/defaults', async (_req, res) => {
    try {
      res.json(await adapter.getDefaults());
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes worker unavailable') });
    }
  });

  router.patch('/defaults', async (req, res) => {
    if (!isRecord(req.body)) {
      return res.status(400).json({ error: 'Request body is required' });
    }

    const updates: { provider?: string | null; model?: string | null; reasoningEffort?: string | null } = {};

    if ('provider' in req.body) {
      const provider = req.body.provider;
      if (provider !== null && typeof provider !== 'string') {
        return res.status(400).json({ error: 'provider must be a string or null' });
      }
      updates.provider = typeof provider === 'string' ? provider.trim() || null : null;
    }

    if ('model' in req.body) {
      const model = req.body.model;
      if (model !== null && typeof model !== 'string') {
        return res.status(400).json({ error: 'model must be a string or null' });
      }
      updates.model = typeof model === 'string' ? model.trim() || null : null;
    }

    if ('reasoningEffort' in req.body) {
      const effort = req.body.reasoningEffort;
      if (effort !== null && (typeof effort !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(effort))) {
        return res.status(400).json({ error: `reasoningEffort must be one of: ${REASONING_EFFORTS.join(', ')}` });
      }
      updates.reasoningEffort = effort as ReasoningEffort | null;
    }

    try {
      const defaults = await adapter.setDefaults(updates);
      res.json(defaults);
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Failed to update defaults') });
    }
  });

  router.get('/models', async (_req, res) => {
    try {
      res.json(await adapter.getModels());
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes worker unavailable') });
    }
  });

  return router;
}

export function createTaskAgentSettingsRouter(adapter: HermesWorkerAdapter): Router {
  const router = Router();

  router.get('/:id/agent-settings', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const defaults = await defaultsForSettings(adapter);
    res.json(buildTaskSettings(task, defaults));
  });

  return router;
}
