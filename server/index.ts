import 'dotenv/config';
import './logging.js';
import './db/index.js';
import { createServer, type Server } from 'node:http';
import app, { adapter } from './app.js';
import { mountFrontend, type FrontendCleanup } from './frontend.js';
import { ensureHermesExternalSkillsDir } from './routes/skills.js';
import { attachTerminalWebSocket } from './terminal.js';

const PORT = parseInt(process.env.PORT || '7460', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PORT_FALLBACK_ATTEMPTS = 20;

const httpServer = createServer(app);
let closeFrontend: FrontendCleanup = () => {};
let closeTerminal: () => Promise<void> | void = () => {};
let shuttingDown = false;

type ShutdownReason = NodeJS.Signals | 'startup-error';

async function listenWithFallback(
  server: Server,
  startPort: number,
  maxAttempts: number,
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const tryPort = startPort + i;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          rejectListen(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolveListen();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(tryPort, HOST);
      });
      if (tryPort !== startPort) {
        console.warn(`Port ${startPort} was busy — using port ${tryPort} instead.`);
      }
      return tryPort;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(
    `Could not find a free port after ${maxAttempts} attempts starting from ${startPort}.`,
  );
}

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
  closeTerminal = attachTerminalWebSocket(httpServer);
  try {
    await adapter.start();
  } catch (error) {
    console.error(
      'Hermes worker failed to start — UI will load but agent features are unavailable until the worker recovers:',
      error instanceof Error ? error.message : error,
    );
  }
  const boundPort = await listenWithFallback(httpServer, PORT, PORT_FALLBACK_ATTEMPTS);

  console.log(`AgentControl running on http://${HOST}:${boundPort}`);
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
    closeTerminal(),
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
