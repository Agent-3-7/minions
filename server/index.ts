import 'dotenv/config';
import './db/index.js';
import { once } from 'node:events';
import { createServer } from 'node:http';
import app, { adapter } from './app.js';
import { mountFrontend, type FrontendCleanup } from './frontend.js';
import { ensureHermesExternalSkillsDir } from './routes/skills.js';

const PORT = parseInt(process.env.PORT || '6969', 10);
const HOST = process.env.HOST || '127.0.0.1';

const httpServer = createServer(app);
let closeFrontend: FrontendCleanup = () => {};
let shuttingDown = false;

type ShutdownReason = NodeJS.Signals | 'startup-error';

async function main() {
  // Re-register the skills dir with Hermes every boot, so installed skills stay
  // visible even if config.yaml was regenerated or skills were restored on disk.
  await ensureHermesExternalSkillsDir().catch((error) => {
    console.error(
      'Failed to register skills directory with Hermes — installed skills may not load:',
      error instanceof Error ? error.message : error,
    );
  });

  closeFrontend = await mountFrontend(app, httpServer);
  try {
    await adapter.start();
  } catch (error) {
    console.error(
      'Hermes worker failed to start — UI will load but agent features are unavailable until the worker recovers:',
      error instanceof Error ? error.message : error,
    );
  }
  httpServer.listen(PORT, HOST);
  await once(httpServer, 'listening');

  console.log(`Hermes Agent Mission Control running on http://${HOST}:${PORT}`);
}

function closeHttpServer(): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    if (!httpServer.listening) {
      resolveClose();
      return;
    }

    httpServer.close((error?: Error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });

    httpServer.closeAllConnections();
  });
}

async function shutdown(reason: ShutdownReason, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    httpServer.closeAllConnections();
    process.exit(1);
  }
  shuttingDown = true;

  const forceExit = setTimeout(() => {
    console.error(`Forced shutdown after ${reason}`);
    process.exit(1);
  }, 5000);
  forceExit.unref();

  const results = await Promise.allSettled([
    closeHttpServer(),
    closeFrontend(),
    adapter.stop(),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') console.error(result.reason);
  }

  clearTimeout(forceExit);
  process.exit(results.some((result) => result.status === 'rejected') ? 1 : exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  console.error(error);
  void shutdown('startup-error', 1);
});
