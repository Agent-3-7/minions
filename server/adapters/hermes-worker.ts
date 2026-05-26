import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type {
  AgentDefaults,
  AgentModelsResponse,
  CompactResult,
  GoalDecision,
  GoalStateSnapshot,
  ScheduledTask,
  ScheduledTaskInput,
  SessionMetadata,
  TaskMessage,
} from '../../shared/types.js';
import type { AgentAdapter, AgentRunOptions, AgentRunSettings, StreamEvent } from './types.js';
import type { WorkerEvent, WorkerRequest, WorkerResult, WorkerErrorPayload } from './worker-protocol.js';
import { expandHomePrefix, resolveHermesHome, resolveAgentControlWorkspaceDir } from '../paths.js';

const WORKER_READY_TIMEOUT_MS = 10_000;
const WORKER_INTERRUPT_TIMEOUT_MS = 10_000;

type WorkerRequestInput = WorkerRequest extends infer Request
  ? Request extends WorkerRequest
    ? Omit<Request, 'id'>
    : never
  : never;

type PendingRequest = {
  kind: 'request';
  resolve: (value: WorkerResult) => void;
  reject: (error: Error) => void;
};

type PendingStream = {
  kind: 'stream';
  push: (event: WorkerEvent) => void;
  end: () => void;
  fail: (error: Error) => void;
};

type Pending = PendingRequest | PendingStream;

function resolveAgentDirFromHermesCli(): string | undefined {
  try {
    const hermesBin = execFileSync('which', ['hermes'], { encoding: 'utf8' }).trim();
    const real = realpathSync(hermesBin);
    // Typical layout: <agent-dir>/venv/bin/hermes → agent dir is 3 levels up
    const candidate = resolve(dirname(real), '..', '..');
    if (existsSync(join(candidate, 'run_agent.py'))) return candidate;
  } catch {
    // `which` failed or path doesn't resolve — not installed via standard installer
  }
  return undefined;
}

function resolvePython(): string {
  if (process.env.HERMES_PYTHON) return expandHomePrefix(process.env.HERMES_PYTHON);

  const candidates: string[] = [];
  if (process.env.HERMES_AGENT_DIR) {
    candidates.push(join(expandHomePrefix(process.env.HERMES_AGENT_DIR), 'venv/bin/python'));
  }
  candidates.push(join(resolveHermesHome(), 'hermes-agent/venv/bin/python'));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  const cliAgentDir = resolveAgentDirFromHermesCli();
  if (cliAgentDir) {
    const venvPython = join(cliAgentDir, 'venv/bin/python');
    if (existsSync(venvPython)) return venvPython;
  }

  return 'python3';
}

function resolveWorkerScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../workers/hermes_worker.py'),
    resolve(here, '../../server/workers/hermes_worker.py'),
    resolve(process.cwd(), 'server/workers/hermes_worker.py'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Hermes worker script not found. Tried: ${candidates.join(', ')}`);
  return found;
}

function formatWorkerError(error: string | WorkerErrorPayload | undefined): string {
  if (!error) return 'Hermes worker error';
  if (typeof error === 'string') return error;

  const code = error.code ? `[${error.code}] ` : '';
  const hint = error.hint ? ` ${error.hint}` : '';
  return `${code}${error.message}${hint}`;
}

function workerErrorCode(error: string | WorkerErrorPayload | undefined): string | undefined {
  return typeof error === 'object' ? error.code : undefined;
}

class HermesWorkerError extends Error {
  code?: string;

  constructor(error: string | WorkerErrorPayload | undefined) {
    super(formatWorkerError(error));
    this.name = 'HermesWorkerError';
    this.code = workerErrorCode(error);
  }
}

function createAsyncQueue<T>() {
  const values: T[] = [];
  const waiters: {
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }[] = [];
  let ended = false;
  let failure: Error | null = null;

  return {
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else values.push(value);
    },
    end() {
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()?.resolve({ value: undefined as T, done: true });
      }
    },
    fail(error: Error) {
      failure = error;
      while (waiters.length > 0) {
        waiters.shift()?.reject(error);
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (values.length > 0) {
            return Promise.resolve({ value: values.shift() as T, done: false });
          }
          if (failure) return Promise.reject(failure);
          if (ended) return Promise.resolve({ value: undefined as T, done: true });
          return new Promise((resolveNext, reject) => {
            waiters.push({ resolve: resolveNext, reject });
          });
        },
        return(): Promise<IteratorResult<T>> {
          ended = true;
          values.length = 0;
          return Promise.resolve({ value: undefined as T, done: true });
        },
      };
    },
  };
}

class HermesWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readline: Interface | null = null;
  private pending = new Map<string, Pending>();
  private ready = false;
  private readyPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    this.ensureStarted();
    if (this.ready) return;

    if (!this.readyPromise) {
      const request = { id: randomUUID(), type: 'health' } as WorkerRequest;
      this.readyPromise = this.sendRequest<{ ok: boolean }>(request, WORKER_READY_TIMEOUT_MS)
        .then((result) => {
          if (!result.ok) throw new Error('Hermes worker healthcheck failed');
          this.ready = true;
        })
        .catch((error) => {
          this.ready = false;
          if (this.child && !this.child.killed) this.child.kill();
          throw error;
        })
        .finally(() => {
          this.readyPromise = null;
        });
    }

    await this.readyPromise;
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.readyPromise = null;

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    this.failPending(new Error('Hermes worker stopped'));

    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      let forceTimer: ReturnType<typeof setTimeout> | null = null;

      const done = () => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        resolve();
      };

      forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        done();
      }, 500);
      forceTimer.unref();

      child.once('exit', done);
      child.once('error', done);

      try {
        if (!child.stdin.destroyed) child.stdin.end();
      } catch {
        // The worker may already be exiting because the terminal delivered SIGINT.
      }

      if (!child.killed) child.kill(signal);
    });
  }

  async request<T extends WorkerResult>(input: WorkerRequest['type'] | WorkerRequestInput, timeoutMs?: number): Promise<T> {
    await this.start();
    const id = randomUUID();
    const request = typeof input === 'string'
      ? { id, type: input } as WorkerRequest
      : { ...input, id } as WorkerRequest;
    return await this.sendRequest<T>(request, timeoutMs);
  }

  async *stream(request: Omit<Extract<WorkerRequest, { type: 'chat' }>, 'id'>): AsyncIterable<WorkerEvent> {
    await this.start();
    const id = randomUUID();
    const queue = createAsyncQueue<WorkerEvent>();

    try {
      this.pending.set(id, {
        kind: 'stream',
        push: queue.push,
        end: queue.end,
        fail: queue.fail,
      });

      this.write({ ...request, id });

      for await (const event of queue) {
        yield event;
      }
    } finally {
      this.pending.delete(id);
    }
  }

  private async sendRequest<T extends WorkerResult>(request: WorkerRequest, timeoutMs?: number): Promise<T> {
    this.ensureStarted();

    return await new Promise<T>((resolveRequest, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const clearRequestTimeout = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      this.pending.set(request.id, {
        kind: 'request',
        resolve: (value) => {
          clearRequestTimeout();
          resolveRequest(value as T);
        },
        reject: (error) => {
          clearRequestTimeout();
          reject(error);
        },
      });

      if (timeoutMs) {
        timeout = setTimeout(() => {
          this.pending.delete(request.id);
          reject(new Error(`Hermes worker did not respond within ${timeoutMs}ms`));
        }, timeoutMs);
      }

      try {
        this.write(request);
      } catch (error) {
        clearRequestTimeout();
        this.pending.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureStarted(): void {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;

    const python = resolvePython();
    const script = resolveWorkerScript();
    const workspace = resolveAgentControlWorkspaceDir();
    mkdirSync(workspace, { recursive: true });
    const child = spawn(python, [script], {
      cwd: workspace,
      env: {
        ...process.env,
        HERMES_QUIET: '1',
        HERMES_YOLO_MODE: '1',
      },
    });

    this.child = child;
    this.ready = false;
    this.readline = createInterface({ input: child.stdout });
    this.readline.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
    child.on('error', (error) => this.handleExit(error));
    child.on('exit', (code, signal) => {
      this.handleExit(new Error(`Hermes worker exited (${signal ?? code ?? 'unknown'})`));
    });
  }

  private handleLine(line: string): void {
    let event: WorkerEvent;
    try {
      event = JSON.parse(line) as WorkerEvent;
    } catch {
      process.stderr.write(`[hermes-worker] non-json stdout: ${line}\n`);
      return;
    }

    const pending = this.pending.get(event.id);
    if (!pending) return;

    if (pending.kind === 'request') {
      if (event.type === 'result') {
        this.pending.delete(event.id);
        pending.resolve(event.data);
      } else if (event.type === 'error') {
        this.pending.delete(event.id);
        pending.reject(new HermesWorkerError(event.error));
      }
      return;
    }

    if (pending.kind !== 'stream') return;

    pending.push(event);
    if (event.type === 'done') {
      this.pending.delete(event.id);
      pending.end();
    }
  }

  private handleExit(error: Error): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    this.child = null;
    this.ready = false;

    this.failPending(new Error(`Hermes worker crashed: ${error.message}`));
  }

  private write(request: WorkerRequest): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('Hermes worker is not running');
    }
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.kind === 'request') pending.reject(error);
      else pending.fail(error);
      this.pending.delete(id);
    }
  }
}

export class HermesWorkerAdapter implements AgentAdapter {
  private client = new HermesWorkerClient();

  async start(): Promise<void> {
    await this.client.start();
  }

  async stop(): Promise<void> {
    await this.client.stop();
  }

  async chat(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): Promise<{ text: string; sessionId: string }> {
    let text = '';
    let resolvedSessionId = sessionId;
    let error: string | null = null;
    let errorCode: string | undefined;

    for await (const event of this.chatStream(sessionId, message, options)) {
      if (event.type === 'text_delta') text += event.content ?? '';
      if (event.type === 'done' && event.sessionId) resolvedSessionId = event.sessionId;
      if (event.type === 'error') {
        error = event.error ?? 'Hermes worker error';
        errorCode = event.code;
      }
    }

    if (error) {
      const err = new Error(error);
      if (errorCode) Object.assign(err, { code: errorCode });
      throw err;
    }
    return { text, sessionId: resolvedSessionId };
  }

  async *chatStream(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): AsyncIterable<StreamEvent> {
    const request: Omit<Extract<WorkerRequest, { type: 'chat' }>, 'id'> = {
      type: 'chat',
      sessionId,
      message,
      systemMessage: options?.systemMessage,
      settings: options?.settings ?? {},
      taskId: options?.task?.id,
      taskTitle: options?.task?.title ?? null,
      parentTask: options?.parentTask,
      delegatedTaskId: options?.delegatedTaskId,
    };
    for await (const event of this.client.stream(request)) {
      switch (event.type) {
        case 'text_delta':
          yield { type: 'text_delta', content: event.content ?? '' };
          break;
        case 'thinking_delta':
          yield { type: 'thinking_delta', content: event.content ?? '' };
          break;
        case 'tool_progress':
          yield {
            type: 'tool_progress',
            tool: event.tool ?? 'tool',
            status: event.status ?? 'running',
            duration: event.duration,
            label: event.label ?? undefined,
          };
          break;
        case 'error':
          yield { type: 'error', error: formatWorkerError(event.error), code: workerErrorCode(event.error) };
          break;
        case 'done':
          yield {
            type: 'done',
            sessionId: event.sessionId ?? sessionId,
            context: event.context,
            interrupted: event.interrupted,
            model: event.model ?? null,
            provider: event.provider ?? null,
          };
          break;
        case 'result':
          break;
      }
    }
  }

  async interruptChat(sessionId: string, reason?: string): Promise<boolean> {
    const result = await this.client.request<{ interrupted: boolean }>({
      type: 'chat.interrupt',
      sessionId,
      taskId: sessionId,
      reason,
    }, WORKER_INTERRUPT_TIMEOUT_MS);
    return result.interrupted;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.start();
      return true;
    } catch {
      return false;
    }
  }

  async getMessages(sessionId: string, taskId: string): Promise<TaskMessage[]> {
    const result = await this.client.request<{ messages: TaskMessage[] }>({
      type: 'session.messages.get',
      sessionId,
      taskId,
    });
    return result.messages;
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const result = await this.client.request<{ session: SessionMetadata | null }>({
      type: 'session.get',
      sessionId,
    });
    return result.session;
  }

  async getDefaults(): Promise<AgentDefaults> {
    return await this.client.request<AgentDefaults>('settings.get');
  }

  async setDefaults(updates: { provider?: string | null; model?: string | null; reasoningEffort?: string | null }): Promise<AgentDefaults> {
    return await this.client.request<AgentDefaults>({
      type: 'settings.set',
      ...updates,
    });
  }

  async getModels(): Promise<AgentModelsResponse> {
    return await this.client.request<AgentModelsResponse>('models.list');
  }

  async listScheduledTasks(includeDisabled = false, limit = 100): Promise<ScheduledTask[]> {
    const result = await this.client.request<{ scheduledTasks: ScheduledTask[] }>({
      type: 'scheduledTasks.list',
      includeDisabled,
      limit,
    });
    return result.scheduledTasks;
  }

  async getScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null> {
    const result = await this.client.request<{ scheduledTask: ScheduledTask | null }>({
      type: 'scheduledTasks.get',
      scheduledTaskId,
    });
    return result.scheduledTask;
  }

  async createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask> {
    const result = await this.client.request<{ scheduledTask: ScheduledTask }>({
      type: 'scheduledTasks.create',
      ...input,
    });
    return result.scheduledTask;
  }

  async updateScheduledTask(scheduledTaskId: string, updates: Partial<ScheduledTaskInput>): Promise<ScheduledTask | null> {
    const result = await this.client.request<{ scheduledTask: ScheduledTask | null }>({
      type: 'scheduledTasks.update',
      scheduledTaskId,
      ...updates,
    });
    return result.scheduledTask;
  }

  async pauseScheduledTask(scheduledTaskId: string, reason?: string): Promise<ScheduledTask | null> {
    const result = await this.client.request<{ scheduledTask: ScheduledTask | null }>({
      type: 'scheduledTasks.pause',
      scheduledTaskId,
      reason,
    });
    return result.scheduledTask;
  }

  async resumeScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null> {
    const result = await this.client.request<{ scheduledTask: ScheduledTask | null }>({
      type: 'scheduledTasks.resume',
      scheduledTaskId,
    });
    return result.scheduledTask;
  }

  async runScheduledTask(scheduledTaskId: string): Promise<ScheduledTask | null> {
    const result = await this.client.request<{ scheduledTask: ScheduledTask | null }>({
      type: 'scheduledTasks.run',
      scheduledTaskId,
    });
    return result.scheduledTask;
  }

  async removeScheduledTask(scheduledTaskId: string): Promise<boolean> {
    const result = await this.client.request<{ ok: boolean }>({
      type: 'scheduledTasks.remove',
      scheduledTaskId,
    });
    return result.ok;
  }

  async tickScheduledTasks(): Promise<number> {
    const result = await this.client.request<{ executed: number }>({ type: 'scheduledTasks.tick' });
    return result.executed;
  }

  async generateTitle(description: string): Promise<{ title: string }> {
    return await this.client.request<{ title: string }>({
      type: 'title.generate',
      description,
    });
  }

  async compressSession(
    sessionId: string,
    options?: {
      focusTopic?: string | null;
      currentTokens?: number | null;
      systemMessage?: string;
      settings?: AgentRunSettings;
    },
  ): Promise<CompactResult> {
    return await this.client.request<CompactResult>({
      type: 'session.compress',
      sessionId,
      focusTopic: options?.focusTopic,
      currentTokens: options?.currentTokens,
      systemMessage: options?.systemMessage,
      settings: options?.settings,
    });
  }

  async getGoalStatus(sessionId: string): Promise<GoalStateSnapshot | null> {
    const result = await this.client.request<{ goal: GoalStateSnapshot | null }>({
      type: 'goal.status',
      sessionId,
    });
    return result.goal;
  }

  async setGoal(
    sessionId: string,
    goal: string,
    options?: { maxTurns?: number | null },
  ): Promise<GoalStateSnapshot> {
    const result = await this.client.request<{ goal: GoalStateSnapshot | null }>({
      type: 'goal.set',
      sessionId,
      goal,
      maxTurns: options?.maxTurns,
    });
    if (!result.goal) throw new Error('Hermes did not return goal state');
    return result.goal;
  }

  async pauseGoal(sessionId: string, reason?: string): Promise<GoalStateSnapshot | null> {
    const result = await this.client.request<{ goal: GoalStateSnapshot | null }>({
      type: 'goal.pause',
      sessionId,
      reason,
    });
    return result.goal;
  }

  async resumeGoal(sessionId: string): Promise<GoalStateSnapshot | null> {
    const result = await this.client.request<{ goal: GoalStateSnapshot | null }>({
      type: 'goal.resume',
      sessionId,
    });
    return result.goal;
  }

  async clearGoal(sessionId: string): Promise<boolean> {
    const result = await this.client.request<{ cleared: boolean }>({
      type: 'goal.clear',
      sessionId,
    });
    return result.cleared;
  }

  async evaluateGoal(sessionId: string, responseText: string): Promise<GoalDecision> {
    return await this.client.request<GoalDecision>({
      type: 'goal.evaluate',
      sessionId,
      responseText,
    });
  }
}
