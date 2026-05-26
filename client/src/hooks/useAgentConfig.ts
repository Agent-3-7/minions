import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchAgentDefaults, fetchAgentModels, fetchTaskAgentSettings } from '../lib/api';
import type { AgentRunSettings } from '../lib/api';
import { readCachedAgentDefaults, writeCachedAgentDefaults } from '../lib/agentDefaultsCache';
import type { AgentDefaults, AgentModelGroup, ReasoningEffort } from '@shared/types';

export function useAgentConfig(taskId?: string, initialSettings?: AgentRunSettings) {
  const [defaults, setDefaults] = useState<AgentDefaults | null>(() => readCachedAgentDefaults());
  const [modelGroups, setModelGroups] = useState<AgentModelGroup[]>([]);
  const [model, setModel] = useState<string | null>(initialSettings?.model ?? null);
  const [provider, setProvider] = useState<string | null>(initialSettings?.provider ?? null);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(initialSettings?.reasoningEffort ?? null);
  const [isLoading, setIsLoading] = useState(true);
  const initialRef = useRef(initialSettings);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    Promise.allSettled([
      taskId ? fetchTaskAgentSettings(taskId) : fetchAgentDefaults(),
      fetchAgentModels(),
    ]).then(([settingsResult, modelsResult]) => {
      if (cancelled) return;
      if (settingsResult.status === 'fulfilled') {
        const val = settingsResult.value;
        if ('task' in val) {
          writeCachedAgentDefaults(val.defaults);
          setDefaults(val.defaults);
          setModel(val.task.model ?? initialRef.current?.model ?? null);
          setProvider(val.task.provider ?? initialRef.current?.provider ?? null);
          setReasoningEffort(val.task.reasoningEffort ?? initialRef.current?.reasoningEffort ?? null);
        } else {
          writeCachedAgentDefaults(val);
          setDefaults(val);
        }
      }
      if (modelsResult.status === 'fulfilled') {
        setModelGroups(modelsResult.value.groups);
      }
    }).finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [taskId]);

  const replaceDefaults = useCallback((d: AgentDefaults) => {
    writeCachedAgentDefaults(d);
    setDefaults(d);
  }, []);

  return { defaults, modelGroups, model, setModel, provider, setProvider, reasoningEffort, setReasoningEffort, isLoading, replaceDefaults };
}
