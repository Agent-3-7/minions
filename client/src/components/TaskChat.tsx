import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { ArrowUp, Loader2, ChevronDown, ChevronRight, Check, Terminal, FileText, FilePenLine, Globe, Code, Wrench } from 'lucide-react';
import { InputToolbar, ContextRing } from './InputToolbar';
import { MarkdownContent } from './MarkdownContent';
import { useChat, ToolProgressEvent } from '../hooks/useChat';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { handleChatKeyDown } from '../lib/keyboard';
import type { AgentRunSettings } from '../lib/api';

interface TaskChatProps {
  taskId: string;
  initialMessage?: string;
  initialSettings?: AgentRunSettings;
}

function ThinkingBlock({ content, isLive }: { content: string; isLive: boolean }) {
  const [expanded, setExpanded] = useState(isLive);

  useEffect(() => {
    if (isLive) setExpanded(true);
  }, [isLive]);

  if (!content) return null;

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{isLive ? 'Thinking…' : 'Thought process'}</span>
        {isLive && <Loader2 size={10} className="animate-spin" />}
      </button>
      {expanded && (
        <div className="mt-2 ml-1 pl-4 py-1 border-l-2 border-zinc-200 dark:border-zinc-700 text-xs text-zinc-400 dark:text-zinc-500 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
}

const TOOL_ICONS: Record<string, typeof Terminal> = {
  terminal: Terminal,
  process: Terminal,
  read_file: FileText,
  write_file: FilePenLine,
  patch: FilePenLine,
  execute_code: Code,
  web_search: Globe,
  web_extract: Globe,
  browser_navigate: Globe,
  browser_snapshot: Globe,
  browser_vision: Globe,
};

const CHAT_COLUMN_CLASS = 'w-full max-w-[760px] mx-auto';

function getToolIcon(name: string) {
  return TOOL_ICONS[name] ?? Wrench;
}

function formatToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function ToolCallBlock({ tool }: { tool: ToolProgressEvent }) {
  const Icon = getToolIcon(tool.tool);
  return (
    <div className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl border ${
      tool.status === 'error'
        ? 'border-red-200 dark:border-red-900'
        : 'border-zinc-200 dark:border-zinc-700'
    }`}>
      <Icon size={14} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
      <span className={`text-sm font-medium shrink-0 ${
        tool.status === 'error'
          ? 'text-red-500 dark:text-red-400'
          : 'text-zinc-600 dark:text-zinc-300'
      }`}>
        {formatToolName(tool.tool)}
      </span>
      {tool.label && (
        <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono truncate min-w-0">
          {tool.label}
        </span>
      )}
      {tool.status === 'running' && <Loader2 size={14} className="animate-spin text-zinc-400 shrink-0" />}
      {tool.status === 'completed' && <Check size={14} className="text-zinc-400 shrink-0" />}
      {tool.duration != null && (
        <span className="text-xs text-zinc-300 dark:text-zinc-600 ml-auto shrink-0 tabular-nums">
          {tool.duration.toFixed(1)}s
        </span>
      )}
    </div>
  );
}

export function TaskChat({ taskId, initialMessage, initialSettings }: TaskChatProps) {
  const { messages, isStreaming, thinkingContent, activeTools, context, sendMessage, loadMessages } = useChat();
  const [input, setInput] = useState('');
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  const startupRef = useRef({ taskId, initialMessage, initialSettings });
  if (startupRef.current.taskId !== taskId) {
    startupRef.current = { taskId, initialMessage, initialSettings };
  }
  const { defaults, modelGroups, model, setModel, reasoningEffort, setReasoningEffort, isLoading } = useAgentConfig(
    taskId,
    startupRef.current.initialSettings,
  );
  const waitingForTaskSettings = isLoading && !startupRef.current.initialSettings;
  const toolbarDefaults = waitingForTaskSettings ? null : defaults;
  const configPending = waitingForTaskSettings || (!defaults && isLoading);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const didInitialScrollRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoadedTaskId(null);
    didInitialScrollRef.current = false;
    loadMessages(taskId)
      .then((loadedMessages) => {
        if (cancelled) return;
        setLoadedTaskId(taskId);
        const firstMessage = startupRef.current.initialMessage;
        if (firstMessage) {
          startupRef.current.initialMessage = undefined;
          if (loadedMessages.length === 0) {
            sendMessage(taskId, firstMessage, startupRef.current.initialSettings);
          }
        }
      })
      .catch(() => {});
    inputRef.current?.focus();
    return () => { cancelled = true; };
  }, [taskId, loadMessages, sendMessage]);

  useLayoutEffect(() => {
    if (loadedTaskId !== taskId || didInitialScrollRef.current) return;

    const container = messagesContainerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    didInitialScrollRef.current = true;
  }, [loadedTaskId, messages.length, taskId]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming || configPending) return;
    setInput('');
    await sendMessage(taskId, text, { model, reasoningEffort });
  }, [configPending, input, isStreaming, taskId, sendMessage, model, reasoningEffort]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => handleChatKeyDown(e, handleSubmit),
    [handleSubmit],
  );

  return (
    <div className="flex w-full flex-col flex-1 min-h-0">
      <div className="relative flex-1 min-h-0">
        <div
          ref={messagesContainerRef}
          className="h-full overflow-y-auto px-4 sm:px-6 py-4"
        >
          <div className={`${CHAT_COLUMN_CLASS} space-y-3`}>
            {messages.length === 0 && (
              <p className="text-sm text-zinc-400 dark:text-zinc-500 text-center py-12">
                Start a conversation with your assistant.
              </p>
            )}
            {messages.map((msg, idx) => {
              if (msg.role === 'user') {
                return (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100">
                      {msg.content}
                    </div>
                  </div>
                );
              }

              const isLastAssistant = idx === messages.length - 1 && msg.role === 'assistant';
              const thinkingToShow = isLastAssistant && isStreaming ? thinkingContent : (msg.thinking || '');
              const isLiveThinking = isLastAssistant && isStreaming && !!thinkingContent;
              const toolsToShow = isLastAssistant && isStreaming ? activeTools : (msg.tools ?? []);
              const showSpinner = isLastAssistant && isStreaming && !msg.content && !thinkingContent && !activeTools.some(t => t.status === 'running');

              return (
                <div key={msg.id} className="flex justify-start">
                  <div className="w-full px-1 sm:px-2">
                    {thinkingToShow && (
                      <ThinkingBlock content={thinkingToShow} isLive={isLiveThinking} />
                    )}
                    {toolsToShow.length > 0 && (
                      <div className="mb-4 space-y-2.5">
                        {toolsToShow.map((tool, i) => (
                          <ToolCallBlock key={`${tool.tool}-${i}`} tool={tool} />
                        ))}
                      </div>
                    )}
                    <div className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                      {msg.content ? (
                        <MarkdownContent content={msg.content} isStreaming={isLastAssistant && isStreaming} />
                      ) : (
                        showSpinner && (
                          <span className="inline-flex items-center gap-2 text-zinc-400 dark:text-zinc-500">
                            <span>Thinking</span>
                            <span className="inline-flex gap-1">
                              {[0, 150, 300].map((delay) => (
                                <span
                                  key={delay}
                                  className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"
                                  style={{ animationDelay: `${delay}ms` }}
                                />
                              ))}
                            </span>
                          </span>
                        )
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 py-4 border-t border-zinc-100 dark:border-zinc-800">
        <div className={`${CHAT_COLUMN_CLASS} rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800`}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message your assistant..."
            rows={2}
            className="w-full resize-none bg-transparent px-5 pt-3 pb-1 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none leading-relaxed"
          />
          <div className="flex items-center justify-between px-4 pb-3">
            <InputToolbar
              model={model}
              reasoningEffort={reasoningEffort}
              defaults={toolbarDefaults}
              modelGroups={modelGroups}
              disabled={isStreaming}
              onModelChange={setModel}
              onReasoningEffortChange={setReasoningEffort}
            />
            <div className="flex items-center gap-2">
              {context && <ContextRing context={context} />}
              <button
                onClick={handleSubmit}
                disabled={!input.trim() || isStreaming || configPending}
                className="p-2 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-30 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
              >
                <ArrowUp size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
