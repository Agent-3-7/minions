import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { spawn as spawnPty, type IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import {
  TERMINAL_WS_PATH,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from '../shared/types.js';
import { resolveAgentControlWorkspaceDir } from './paths.js';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const INHERITED_TERMINAL_ENV_KEYS_TO_DROP = new Set([
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
]);

function pickShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/zsh';
}

function buildTerminalEnv(): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || INHERITED_TERMINAL_ENV_KEYS_TO_DROP.has(key)) continue;
    env[key] = value;
  }

  env.TERM = 'xterm-256color';
  return env;
}

function safeDimension(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < 2) return 2;
  if (n > 1000) return 1000;
  return n;
}

function sendServerMessage(ws: WebSocket, msg: TerminalServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function handleConnection(ws: WebSocket): void {
  const shell = pickShell();
  let pty: IPty;
  try {
    pty = spawnPty(shell, [], {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: resolveAgentControlWorkspaceDir(),
      env: buildTerminalEnv(),
    });
  } catch (error) {
    sendServerMessage(ws, {
      type: 'error',
      message: `Failed to spawn shell: ${error instanceof Error ? error.message : String(error)}`,
    });
    ws.close();
    return;
  }

  const onData = pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, 'utf8'), { binary: true });
  });

  const onExit = pty.onExit(({ exitCode, signal }) => {
    sendServerMessage(ws, { type: 'exit', exitCode, signal: signal ?? null });
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on('message', (raw) => {
    let msg: TerminalClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as TerminalClientMessage;
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      pty.write(msg.data);
    } else if (msg.type === 'resize') {
      const cols = safeDimension(msg.cols, DEFAULT_COLS);
      const rows = safeDimension(msg.rows, DEFAULT_ROWS);
      try {
        pty.resize(cols, rows);
      } catch {
        // pty may have just exited
      }
    }
  });

  const cleanup = () => {
    onData.dispose();
    onExit.dispose();
    try { pty.kill(); } catch { /* already gone */ }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

export function attachTerminalWebSocket(httpServer: Server): () => Promise<void> {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', handleConnection);

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url ?? '';
    if (!url.startsWith(TERMINAL_WS_PATH)) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  };

  httpServer.on('upgrade', onUpgrade);

  return () =>
    new Promise<void>((resolveClose) => {
      httpServer.off('upgrade', onUpgrade);
      wss.close(() => resolveClose());
    });
}
