import type { Response } from 'express';
import type { BoardEvent } from '../shared/types.js';

export type { BoardEvent };

const clients = new Set<Response>();

const KEEPALIVE_INTERVAL_MS = 30_000;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    for (const client of clients) {
      try { client.write(':keepalive\n\n'); } catch { clients.delete(client); }
    }
    if (clients.size === 0) {
      clearInterval(keepaliveTimer!);
      keepaliveTimer = null;
    }
  }, KEEPALIVE_INTERVAL_MS);
}

export function initSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

export function addClient(res: Response) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
  startKeepalive();
}

function writeEvent(res: Response, event: BoardEvent): boolean {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  try {
    return res.write(data);
  } catch {
    return false;
  }
}

export function sendEvent(res: Response, event: BoardEvent): void {
  writeEvent(res, event);
}

export function broadcast(event: BoardEvent) {
  for (const client of clients) {
    if (!writeEvent(client, event)) clients.delete(client);
  }
}
