import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUp, Loader2 } from 'lucide-react';
import { InputToolbar } from './InputToolbar';
import { createTask } from '../lib/api';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { isEditableTarget, handleChatKeyDown } from '../lib/keyboard';

export function NewTaskPage() {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const { defaults, modelGroups, model, setModel, reasoningEffort, setReasoningEffort, isLoading } = useAgentConfig();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isEditableTarget(e)) navigate('/');
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isCreating || (!defaults && isLoading)) return;
    setIsCreating(true);
    try {
      const { task } = await createTask(text);
      navigate(`/tasks/${task.id}`, {
        state: {
          initialMessage: text,
          initialSettings: { model, reasoningEffort },
        },
      });
    } catch {
      setIsCreating(false);
    }
  }, [defaults, input, isCreating, isLoading, model, navigate, reasoningEffort]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => handleChatKeyDown(e, handleSubmit),
    [handleSubmit],
  );

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 pb-24">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-6">
        What do you need done?
      </h1>

      <div className="w-full max-w-2xl">
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-sm overflow-hidden">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your task in detail..."
            rows={4}
            className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none leading-relaxed"
          />
          <div className="flex items-center justify-between px-4 pb-3">
            <InputToolbar
              model={model}
              reasoningEffort={reasoningEffort}
              defaults={defaults}
              modelGroups={modelGroups}
              disabled={isCreating}
              onModelChange={setModel}
              onReasoningEffortChange={setReasoningEffort}
            />
            <button
              onClick={handleSubmit}
              disabled={!input.trim() || isCreating || (!defaults && isLoading)}
              className="p-2.5 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-30 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
            >
              {isCreating ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <ArrowUp size={16} />
              )}
            </button>
          </div>
        </div>
        <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center mt-3">
          The more context you give, the better your assistant will do.
        </p>
      </div>
    </div>
  );
}
