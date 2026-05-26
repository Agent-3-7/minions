import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  ContextUsage,
  LiveChatMessage,
  LiveChatRun,
  TaskMessage,
  ToolProgressEvent,
} from '@shared/types';
import { fetchMessages, BASE } from '../lib/api';
import { toErrorMessage } from '../lib/format';
import type { AgentRunSettings } from '../lib/api';

export type { ContextUsage, ToolProgressEvent };

export type SendMessageResult =
  | { ok: true; runId?: string }
  | { ok: false; conflict?: boolean; error: string };

interface SendMessageOptions {
  appendLocalError?: boolean;
}

type ChatMessage = Omit<TaskMessage, 'task_id'> & {
  task_id?: string;
  tools?: ToolProgressEvent[];
};

type LiveEvent =
  | { type: 'snapshot'; run: LiveChatRun }
  | { type: 'text_delta'; content?: string }
  | { type: 'thinking_delta'; content?: string }
  | {
      type: 'tool_progress';
      tool?: string;
      status?: ToolProgressEvent['status'];
      duration?: number;
      label?: string;
      codeDiff?: ToolProgressEvent['codeDiff'];
    }
  | { type: 'done'; sessionId?: string; context?: ContextUsage | null; interrupted?: boolean }
  | { type: 'error'; error?: string };

function compactSettings(settings?: AgentRunSettings): AgentRunSettings | undefined {
  if (!settings) return undefined;
  const compacted: AgentRunSettings = {};
  if (settings.model != null) compacted.model = settings.model;
  if (settings.provider != null) compacted.provider = settings.provider;
  if (settings.reasoningEffort != null) compacted.reasoningEffort = settings.reasoningEffort;
  if (settings.mode != null) compacted.mode = settings.mode;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function findLastAssistant(messages: LiveChatMessage[]): LiveChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i];
  }
}

function ensureAssistant(run: LiveChatRun): LiveChatMessage {
  const existing = findLastAssistant(run.messages);
  if (existing) return existing;
  const msg: LiveChatMessage = {
    id: crypto.randomUUID(),
    task_id: run.taskId,
    role: 'assistant',
    content: '',
    created_at: Date.now(),
  };
  run.messages.push(msg);
  return msg;
}

function mergeToolProgress(tools: ToolProgressEvent[], event: Extract<LiveEvent, { type: 'tool_progress' }>) {
  const tool: ToolProgressEvent = {
    tool: event.tool ?? 'tool',
    status: event.status ?? 'running',
    duration: event.duration,
    label: event.label,
    codeDiff: event.codeDiff ?? null,
  };

  if (tool.status === 'running') return [...tools, tool];

  const next = [...tools];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].tool === tool.tool && next[i].status === 'running') {
      next[i] = {
        ...next[i],
        ...tool,
        label: tool.label ?? next[i].label,
        codeDiff: tool.codeDiff ?? next[i].codeDiff,
      };
      return next;
    }
  }

  return [...next, tool];
}

function snapshotMessages(messages: LiveChatMessage[]): ChatMessage[] {
  return messages.map((msg) => ({
    ...msg,
    tools: msg.tools ? msg.tools.map((t) => ({ ...t })) : undefined,
  }));
}

function sameRoleAndContent(left?: ChatMessage, right?: ChatMessage): boolean {
  return !!left && !!right && left.role === right.role && left.content === right.content;
}

function committedWithoutLiveRun(committed: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  const firstLive = live[0];
  if (!firstLive || firstLive.role !== 'user') return committed;

  const lastCommitted = committed[committed.length - 1];
  const secondLastCommitted = committed[committed.length - 2];
  const lastLive = live[live.length - 1];

  if (
    sameRoleAndContent(secondLastCommitted, firstLive) &&
    lastLive?.role === 'assistant' &&
    sameRoleAndContent(lastCommitted, lastLive)
  ) {
    return committed.slice(0, -2);
  }

  if (sameRoleAndContent(lastCommitted, firstLive)) {
    return committed.slice(0, -1);
  }

  // Goal runs produce multiple user+assistant pairs in committed that overlap with live messages.
  // Scan for the first live user message paired with the last live assistant to find the cut point.
  let finalLiveAssistant: ChatMessage | undefined;
  for (let k = live.length - 1; k >= 0; k--) {
    if (live[k].role === 'assistant' && live[k].content.length > 0) {
      finalLiveAssistant = live[k];
      break;
    }
  }
  if (finalLiveAssistant) {
    for (let i = committed.length - 1; i >= 0; i--) {
      if (!sameRoleAndContent(committed[i], firstLive)) continue;
      for (let j = i + 1; j < committed.length; j++) {
        if (sameRoleAndContent(committed[j], finalLiveAssistant)) {
          return committed.slice(0, i);
        }
      }
    }
  }

  return committed;
}

function messagesWithLiveRun(committed: ChatMessage[], run: LiveChatRun): ChatMessage[] {
  const live = snapshotMessages(run.messages);
  return [...committedWithoutLiveRun(committed, live), ...live];
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [thinkingContent, setThinkingContent] = useState('');
  const [activeTools, setActiveTools] = useState<ToolProgressEvent[]>([]);
  const [context, setContext] = useState<ContextUsage | null>(null);

  const postAbortRef = useRef<AbortController | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const liveReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRetryRef = useRef(0);
  const taskIdRef = useRef<string | null>(null);
  const committedMessagesRef = useRef<ChatMessage[]>([]);
  const liveRunRef = useRef<LiveChatRun | null>(null);
  const liveContextRef = useRef<ContextUsage | null>(null);
  const rafRef = useRef<number | null>(null);

  const closeLiveSource = useCallback(() => {
    if (liveReconnectTimerRef.current) {
      clearTimeout(liveReconnectTimerRef.current);
      liveReconnectTimerRef.current = null;
    }
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    postAbortRef.current?.abort();
    postAbortRef.current = null;
    closeLiveSource();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [closeLiveSource]);

  const publishState = useCallback(() => {
    const committed = committedMessagesRef.current;
    const liveRun = liveRunRef.current;

    if (liveRun) {
      const isMessageRun = liveRun.kind === 'chat' || liveRun.kind === 'goal';
      const merged = isMessageRun ? messagesWithLiveRun(committed, liveRun) : committed;
      const assistant = isMessageRun ? findLastAssistant(liveRun.messages) : undefined;
      const streaming = isMessageRun && liveRun.status === 'streaming';

      setMessages(merged);
      setIsStreaming(streaming);
      setStopped(isMessageRun && liveRun.status === 'stopped');
      setThinkingContent(streaming ? assistant?.thinking ?? '' : '');
      setActiveTools(streaming ? assistant?.tools?.map((t) => ({ ...t })) ?? [] : []);
      setContext(liveRun.context !== undefined ? liveRun.context : liveContextRef.current);
      return;
    }

    setMessages(committed);
    setIsStreaming(false);
    setStopped(false);
    setThinkingContent('');
    setActiveTools([]);
    setContext(liveContextRef.current);
  }, []);

  const schedulePublish = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      publishState();
    });
  }, [publishState]);

  const applySnapshot = useCallback((run: LiveChatRun) => {
    if (taskIdRef.current && taskIdRef.current !== run.taskId) return;
    taskIdRef.current = run.taskId;

    const existingLiveRun = liveRunRef.current;
    if (existingLiveRun && existingLiveRun.runId !== run.runId) {
      committedMessagesRef.current = messagesWithLiveRun(committedMessagesRef.current, existingLiveRun);
    }

    liveRunRef.current = run;
    if (run.context !== undefined) liveContextRef.current = run.context;
    publishState();
  }, [publishState]);

  const applyLiveEvent = useCallback((event: LiveEvent) => {
    if (event.type === 'snapshot') {
      applySnapshot(event.run);
      return;
    }

    const run = liveRunRef.current;
    if (!run) return;

    if (event.type === 'text_delta' && event.content) {
      ensureAssistant(run).content += event.content;
      run.updatedAt = Date.now();
      schedulePublish();
      return;
    }

    if (event.type === 'thinking_delta' && event.content) {
      const assistant = ensureAssistant(run);
      assistant.thinking = (assistant.thinking ?? '') + event.content;
      run.updatedAt = Date.now();
      schedulePublish();
      return;
    }

    if (event.type === 'tool_progress') {
      const assistant = ensureAssistant(run);
      assistant.tools = mergeToolProgress(assistant.tools ?? [], event);
      run.updatedAt = Date.now();
      schedulePublish();
      return;
    }

    if (event.type === 'error') {
      const error = event.error || 'Unknown error';
      run.status = 'error';
      run.error = error;
      const assistant = ensureAssistant(run);
      if (!assistant.content.includes(`[Error: ${error}]`)) {
        assistant.content = assistant.content
          ? `${assistant.content}\n[Error: ${error}]`
          : `[Error: ${error}]`;
      }
      run.updatedAt = Date.now();
      publishState();
      return;
    }

    if (event.type === 'done') {
      if (event.sessionId) run.sessionId = event.sessionId;
      if (run.status !== 'error') run.status = event.interrupted ? 'stopped' : 'done';
      if (event.context !== undefined) {
        run.context = event.context;
        liveContextRef.current = event.context;
      }
      run.updatedAt = Date.now();
      publishState();
    }
  }, [applySnapshot, publishState, schedulePublish]);

  const openLiveSubscription = useCallback((taskId: string) => {
    const existing = sourceRef.current;
    if (
      existing &&
      taskIdRef.current === taskId &&
      existing.readyState !== EventSource.CLOSED
    ) {
      return;
    }

    closeLiveSource();
    taskIdRef.current = taskId;

    const source = new EventSource(`${BASE}/tasks/${encodeURIComponent(taskId)}/live`);
    source.onopen = () => {
      liveRetryRef.current = 0;
    };
    source.onmessage = (message) => {
      if (taskIdRef.current !== taskId) return;
      try {
        applyLiveEvent(JSON.parse(message.data) as LiveEvent);
      } catch (err) {
        console.warn('Failed to parse live chat event:', message.data, err);
      }
    };
    source.onerror = () => {
      if (taskIdRef.current !== taskId) return;
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
      const delay = Math.min(1000 * 2 ** liveRetryRef.current, 30_000);
      liveRetryRef.current += 1;
      if (liveReconnectTimerRef.current) clearTimeout(liveReconnectTimerRef.current);
      liveReconnectTimerRef.current = setTimeout(() => {
        if (taskIdRef.current === taskId) openLiveSubscription(taskId);
      }, delay);
    };
    sourceRef.current = source;
  }, [applyLiveEvent, closeLiveSource]);

  const clearAllState = useCallback(() => {
    teardown();
    taskIdRef.current = null;
    committedMessagesRef.current = [];
    liveRunRef.current = null;
    liveContextRef.current = null;
    setMessages([]);
    setIsStreaming(false);
    setStopped(false);
    setThinkingContent('');
    setActiveTools([]);
    setContext(null);
  }, [teardown]);

  const loadMessages = useCallback(async (taskId: string) => {
    clearAllState();
    taskIdRef.current = taskId;

    const { messages: msgs, context: persistedContext } = await fetchMessages(taskId);
    if (taskIdRef.current !== taskId) return msgs;

    committedMessagesRef.current = msgs as ChatMessage[];
    liveContextRef.current = persistedContext ?? null;
    publishState();
    openLiveSubscription(taskId);
    return msgs;
  }, [clearAllState, openLiveSubscription, publishState]);

  const appendLocalSendError = useCallback((content: string, error: string) => {
    const now = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content, created_at: now },
      { id: crypto.randomUUID(), role: 'assistant', content: `[Error: ${error}]`, created_at: now },
    ]);
    setIsStreaming(false);
    setThinkingContent('');
    setActiveTools([]);
  }, []);

  const sendMessage = useCallback(async (
    taskId: string,
    content: string,
    settings?: AgentRunSettings,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult> => {
    openLiveSubscription(taskId);

    const abort = new AbortController();
    postAbortRef.current = abort;
    const runSettings = compactSettings(settings);

    try {
      const res = await fetch(`${BASE}/tasks/${encodeURIComponent(taskId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          ...(runSettings ? { settings: runSettings } : {}),
        }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        const error = body.error || `HTTP ${res.status}`;
        if (res.status !== 409 && options?.appendLocalError !== false) appendLocalSendError(content, error);
        return { ok: false, conflict: res.status === 409, error };
      }
      const body = await res.json().catch(() => ({})) as { runId?: string };
      return { ok: true, runId: body.runId };
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const error = toErrorMessage(err, 'Failed to send message.');
        if (options?.appendLocalError !== false) appendLocalSendError(content, error);
        return { ok: false, error };
      }
      return { ok: false, error: 'Message send was cancelled.' };
    } finally {
      if (postAbortRef.current === abort) postAbortRef.current = null;
    }
  }, [appendLocalSendError, openLiveSubscription]);

  useEffect(() => () => {
    teardown();
  }, [teardown]);

  return { messages, isStreaming, stopped, thinkingContent, activeTools, context, sendMessage, loadMessages, reset: clearAllState };
}
