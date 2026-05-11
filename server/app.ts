import express from 'express';
import cors from 'cors';
import { tasksRouter } from './routes/tasks.js';
import { chatRouter } from './routes/chat.js';
import { createAgentRouter, createTaskAgentSettingsRouter } from './routes/agent.js';
import { createCronRouter, createTaskCronRouter } from './routes/cron.js';
import { skillsRouter } from './routes/skills.js';
import { filesRouter } from './routes/files.js';
import { HermesWorkerAdapter } from './adapters/hermes-worker.js';
import { initSSE, addClient, sendEvent } from './events.js';
import { getRunStatuses } from './live-chat.js';

const app = express();

app.use(cors());
app.use(express.json());

const adapter = new HermesWorkerAdapter();

app.get('/api/health', async (_req, res) => {
  const hermes = await adapter.healthCheck();
  res.json({ ok: true, hermes });
});

app.get('/api/events', (req, res) => {
  initSSE(res);
  addClient(res);
  sendEvent(res, { type: 'task_runs_snapshot', runs: getRunStatuses() });
});

app.use('/api/tasks', tasksRouter);
app.use('/api/tasks', createTaskCronRouter(adapter));
app.use('/api/tasks', createTaskAgentSettingsRouter(adapter));
app.use('/api/tasks', chatRouter);
app.use('/api/agent', createAgentRouter(adapter));
app.use('/api/cron', createCronRouter(adapter));
app.use('/api/skills', skillsRouter);
app.use('/api/files', filesRouter);

export { adapter };
export default app;
