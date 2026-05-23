import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  TERMINAL_WS_PATH,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from '@shared/types';
import { useIsDarkMode } from '../hooks/useTheme';

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#27272a',
  cursor: '#27272a',
  cursorAccent: '#ffffff',
  selectionBackground: '#d4d4d8',
  black: '#27272a',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#fafafa',
};

const DARK_THEME = {
  background: '#18181b',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  cursorAccent: '#18181b',
  selectionBackground: '#3f3f46',
  black: '#27272a',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

export function TerminalPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const isDark = useIsDarkMode();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: document.documentElement.classList.contains('dark') ? DARK_THEME : LIGHT_THEME,
      allowProposedApi: true,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    term.focus();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}${TERMINAL_WS_PATH}`);
    ws.binaryType = 'arraybuffer';

    const sendClient = (msg: TerminalClientMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    ws.onopen = () => {
      sendClient({ type: 'resize', cols: term.cols, rows: term.rows });
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
        return;
      }
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as TerminalServerMessage;
          if (msg.type === 'exit') {
            term.write(`\r\n\x1b[2m[process exited${typeof msg.exitCode === 'number' ? ` with code ${msg.exitCode}` : ''}]\x1b[0m\r\n`);
          } else if (msg.type === 'error') {
            term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
          }
        } catch {
          term.write(event.data);
        }
      }
    };

    ws.onerror = () => {
      term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');
    };

    const dataDisposable = term.onData((data) => {
      sendClient({ type: 'input', data });
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      sendClient({ type: 'resize', cols, rows });
    });

    let resizeRaf = 0;
    const handleWindowResize = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        try { fit.fit(); } catch { /* container not ready */ }
      });
    };
    window.addEventListener('resize', handleWindowResize);

    const containerObserver = new ResizeObserver(handleWindowResize);
    containerObserver.observe(container);

    return () => {
      window.removeEventListener('resize', handleWindowResize);
      containerObserver.disconnect();
      cancelAnimationFrame(resizeRaf);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      try { ws.close(); } catch { /* noop */ }
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = isDark ? DARK_THEME : LIGHT_THEME;
  }, [isDark]);

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-white dark:bg-zinc-900">
      <div ref={containerRef} className="flex-1 min-h-0 p-2" />
    </div>
  );
}
