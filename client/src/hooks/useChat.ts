import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  LiveChatMessage,
  LiveChatRun,
  TaskMessage,
  ToolProgressEvent,
  UsageStats,
} from '@shared/types';
import { fetchMessages, BASE } from '../lib/api';
import { toErrorMessage } from '../lib/format';
import type { AgentRunSettings } from '../lib/api';

export type { ToolProgressEvent, UsageStats };

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
    }
  | { type: 'done'; sessionId?: string; usage?: UsageStats }
  | { type: 'error'; error?: string };

const FINISHED_REFETCH_DELAY_MS = 700;

function compactSettings(settings?: AgentRunSettings): AgentRunSettings | undefined {
  if (!settings) return undefined;
  const compacted: AgentRunSettings = {};
  if (settings.model != null) compacted.model = settings.model;
  if (settings.reasoningEffort != null) compacted.reasoningEffort = settings.reasoningEffort;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function findLastUsage(msgs: { role: string; usage?: UsageStats }[]): UsageStats | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].usage) return msgs[i].usage;
  }
}

function hydrateLastAssistantUsage(msgs: ChatMessage[], usage?: UsageStats | null): ChatMessage[] {
  if (!usage) return msgs;

  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'assistant') continue;
    if (msgs[i].usage) return msgs;
    const copy = msgs.slice();
    copy[i] = { ...copy[i], usage: { ...usage } };
    return copy;
  }

  return msgs;
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
  };

  if (tool.status === 'running') return [...tools, tool];

  const next = [...tools];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].tool === tool.tool && next[i].status === 'running') {
      next[i] = {
        ...next[i],
        ...tool,
        label: tool.label ?? next[i].label,
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
    usage: msg.usage ? { ...msg.usage } : undefined,
  }));
}

function liveMessagesFor(committed: ChatMessage[], run: LiveChatRun): ChatMessage[] {
  const live = snapshotMessages(run.messages);
  const firstLive = live[0];
  const lastCommitted = committed[committed.length - 1];

  if (
    firstLive?.role === 'user' &&
    lastCommitted?.role === 'user' &&
    firstLive.content === lastCommitted.content
  ) {
    return live.slice(1);
  }

  return live;
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [thinkingContent, setThinkingContent] = useState('');
  const [activeTools, setActiveTools] = useState<ToolProgressEvent[]>([]);
  const [usage, setUsage] = useState<UsageStats | null>(null);

  const postAbortRef = useRef<AbortController | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const taskIdRef = useRef<string | null>(null);
  const committedMessagesRef = useRef<ChatMessage[]>([]);
  const liveRunRef = useRef<LiveChatRun | null>(null);
  const liveUsageRef = useRef<UsageStats | null>(null);
  const lastCommittedRunIdRef = useRef<string | null>(null);
  const refetchTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const clearRefetchTimer = useCallback(() => {
    if (refetchTimerRef.current !== null) {
      window.clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = null;
    }
  }, []);

  const closeLiveSource = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const teardown = useCallback(() => {
    postAbortRef.current?.abort();
    postAbortRef.current = null;
    closeLiveSource();
    clearRefetchTimer();
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [clearRefetchTimer, closeLiveSource]);

  const publishState = useCallback(() => {
    const committed = committedMessagesRef.current;
    const liveRun = liveRunRef.current;
    const committedUsage = findLastUsage(committed);

    if (liveRun && liveRun.runId !== lastCommittedRunIdRef.current) {
      const merged = [...committed, ...liveMessagesFor(committed, liveRun)];
      const assistant = findLastAssistant(liveRun.messages);
      const streaming = liveRun.status === 'streaming';

      setMessages(merged);
      setIsStreaming(streaming);
      setThinkingContent(streaming ? assistant?.thinking ?? '' : '');
      setActiveTools(streaming ? assistant?.tools?.map((t) => ({ ...t })) ?? [] : []);
      setUsage(liveRun.usage ?? liveUsageRef.current ?? committedUsage ?? null);
      return;
    }

    setMessages(committed);
    setIsStreaming(false);
    setThinkingContent('');
    setActiveTools([]);
    setUsage(liveUsageRef.current ?? committedUsage ?? null);
  }, []);

  const schedulePublish = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      publishState();
    });
  }, [publishState]);

  const refreshCommittedMessages = useCallback(async (taskId: string, finishedRunId?: string) => {
    try {
      const { messages: msgs, usage: persistedUsage } = await fetchMessages(taskId);
      if (taskIdRef.current !== taskId) return;

      committedMessagesRef.current = hydrateLastAssistantUsage(msgs as ChatMessage[], persistedUsage);
      liveUsageRef.current = persistedUsage ?? findLastUsage(committedMessagesRef.current) ?? liveUsageRef.current;

      if (finishedRunId) {
        lastCommittedRunIdRef.current = finishedRunId;
        if (liveRunRef.current?.runId === finishedRunId) liveRunRef.current = null;
      }

      publishState();
    } catch (err) {
      console.warn('Failed to refresh committed messages:', err);
    }
  }, [publishState]);

  const scheduleFinishedRefresh = useCallback((taskId: string, runId: string) => {
    clearRefetchTimer();
    refetchTimerRef.current = window.setTimeout(() => {
      refetchTimerRef.current = null;
      void refreshCommittedMessages(taskId, runId);
    }, FINISHED_REFETCH_DELAY_MS);
  }, [clearRefetchTimer, refreshCommittedMessages]);

  const applySnapshot = useCallback((run: LiveChatRun) => {
    if (taskIdRef.current && taskIdRef.current !== run.taskId) return;
    taskIdRef.current = run.taskId;

    if (run.status === 'done' && run.runId === lastCommittedRunIdRef.current) {
      if (liveRunRef.current?.runId === run.runId) liveRunRef.current = null;
      publishState();
      return;
    }

    liveRunRef.current = run;
    if (run.usage) liveUsageRef.current = run.usage;
    publishState();

    if (run.status === 'done') scheduleFinishedRefresh(run.taskId, run.runId);
  }, [publishState, scheduleFinishedRefresh]);

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
      if (run.status !== 'error') run.status = 'done';
      const assistant = ensureAssistant(run);
      if (event.usage) {
        run.usage = event.usage;
        assistant.usage = event.usage;
        liveUsageRef.current = event.usage;
      }
      run.updatedAt = Date.now();
      publishState();

      if (run.status === 'done') {
        scheduleFinishedRefresh(run.taskId, run.runId);
      }
    }
  }, [applySnapshot, publishState, scheduleFinishedRefresh, schedulePublish]);

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
    source.onmessage = (message) => {
      if (taskIdRef.current !== taskId) return;
      try {
        applyLiveEvent(JSON.parse(message.data) as LiveEvent);
      } catch (err) {
        console.warn('Failed to parse live chat event:', message.data, err);
      }
    };
    source.onerror = () => {};
    sourceRef.current = source;
  }, [applyLiveEvent, closeLiveSource]);

  const clearAllState = useCallback(() => {
    teardown();
    taskIdRef.current = null;
    committedMessagesRef.current = [];
    liveRunRef.current = null;
    liveUsageRef.current = null;
    lastCommittedRunIdRef.current = null;
    setMessages([]);
    setIsStreaming(false);
    setThinkingContent('');
    setActiveTools([]);
    setUsage(null);
  }, [teardown]);

  const loadMessages = useCallback(async (taskId: string) => {
    clearAllState();
    taskIdRef.current = taskId;

    const { messages: msgs, usage: persistedUsage } = await fetchMessages(taskId);
    if (taskIdRef.current !== taskId) return msgs;

    committedMessagesRef.current = hydrateLastAssistantUsage(msgs as ChatMessage[], persistedUsage);
    liveUsageRef.current = persistedUsage ?? findLastUsage(committedMessagesRef.current) ?? null;
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

  const sendMessage = useCallback(async (taskId: string, content: string, settings?: AgentRunSettings) => {
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

      const body = await res.json().catch(() => ({})) as { run?: LiveChatRun; error?: string };

      if (!res.ok) {
        if (res.status !== 409) appendLocalSendError(content, body.error || `HTTP ${res.status}`);
        return;
      }

      if (body.run) applySnapshot(body.run);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        appendLocalSendError(content, toErrorMessage(err, 'Failed to send message.'));
      }
    } finally {
      if (postAbortRef.current === abort) postAbortRef.current = null;
    }
  }, [appendLocalSendError, applySnapshot, openLiveSubscription]);

  useEffect(() => () => {
    teardown();
  }, [teardown]);

  return { messages, isStreaming, thinkingContent, activeTools, usage, sendMessage, loadMessages, reset: clearAllState };
}
