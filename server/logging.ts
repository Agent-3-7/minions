const installedSymbol = Symbol.for('agentcontrol.timestampedLoggingInstalled');

type WritableStream = typeof process.stdout | typeof process.stderr;

function prefixLogLines(text: string, atLineStart: { value: boolean }): string {
  let output = '';

  for (const char of text) {
    if (atLineStart.value) {
      output += `[${new Date().toISOString()}] `;
      atLineStart.value = false;
    }

    output += char;
    if (char === '\n') atLineStart.value = true;
  }

  return output;
}

function installTimestampPrefix(stream: WritableStream): void {
  const originalWrite = stream.write.bind(stream);
  const atLineStart = { value: true };

  stream.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const prefixed = prefixLogLines(text, atLineStart);

    if (typeof encodingOrCallback === 'function') {
      return originalWrite(prefixed, encodingOrCallback as (error?: Error | null) => void);
    }

    return originalWrite(
      prefixed,
      encodingOrCallback as BufferEncoding | undefined,
      callback as ((error?: Error | null) => void) | undefined,
    );
  }) as typeof stream.write;
}

export function installTimestampedLogging(): void {
  const globalState = globalThis as typeof globalThis & { [installedSymbol]?: boolean };
  if (globalState[installedSymbol]) return;
  globalState[installedSymbol] = true;

  installTimestampPrefix(process.stdout);
  installTimestampPrefix(process.stderr);
}

installTimestampedLogging();
