import { useCallback, useEffect, useState } from 'react';
import { Settings, Bot, Sun, Moon, Monitor, Info, Volume2, VolumeX, Play } from 'lucide-react';
import { useTheme, type ThemePreference } from '../hooks/useTheme';
import { useSoundOnComplete } from '../hooks/useSoundOnComplete';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { fetchAppVersion, updateAgentDefaults } from '../lib/api';
import type { AppVersion } from '@shared/types';
import { toErrorMessage } from '../lib/format';
import { ModelPicker, parseQualifiedModelValue, REASONING_LABELS, type ModelPickerSelection } from './InputToolbar';
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@shared/types';

type SegmentOption<T> = { value: T; label: string; icon: typeof Sun };

const themeOptions: SegmentOption<ThemePreference>[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

const soundOptions: SegmentOption<boolean>[] = [
  { value: false, label: 'Off', icon: VolumeX },
  { value: true, label: 'On', icon: Volume2 },
];

function SegmentedGroup<T>({ options, value, onChange }: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-1 gap-1">
      {options.map(({ value: optValue, label, icon: Icon }) => (
        <button
          key={String(optValue)}
          onClick={() => onChange(optValue)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            value === optValue
              ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
              : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300'
          }`}
        >
          <Icon size={14} />
          {label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { enabled: soundEnabled, setEnabled: setSoundEnabled, playPreview } = useSoundOnComplete();

  const { defaults: agentDefaults, modelGroups, isLoading: isLoadingDefaults, replaceDefaults } = useAgentConfig();
  const [appVersion, setAppVersion] = useState<AppVersion | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [savedDefaults, setSavedDefaults] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAppVersion()
      .then((v) => {
        if (!cancelled) setAppVersion(v);
      })
      .catch(() => {
        if (!cancelled) setAppVersion({ name: 'AgentControl', version: 'unknown' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!savedDefaults) return;
    const timer = setTimeout(() => setSavedDefaults(false), 2000);
    return () => clearTimeout(timer);
  }, [savedDefaults]);

  const saveDefaults = useCallback(async (updates: { provider?: string | null; model?: string | null; reasoningEffort?: ReasoningEffort | null }) => {
    setSavingDefaults(true);
    setDefaultsError(null);
    setSavedDefaults(false);
    try {
      const result = await updateAgentDefaults(updates);
      replaceDefaults(result);
      setSavedDefaults(true);
    } catch (error) {
      setDefaultsError(toErrorMessage(error, 'Failed to save'));
    } finally {
      setSavingDefaults(false);
    }
  }, [replaceDefaults]);

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="max-w-2xl space-y-5">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2">Adapter type</h2>
          <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-1 gap-1">
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100">
              <Bot size={14} />
              Hermes
            </div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-zinc-400 dark:text-zinc-500 cursor-not-allowed">
              <Settings size={14} />
              OpenClaw
              <span className="ml-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500">Soon</span>
            </div>
          </div>
        </div>

        <section
          aria-labelledby="default-model-title"
          className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 id="default-model-title" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Default model
              </h2>
              <p className="mt-1 text-sm leading-5 text-zinc-500 dark:text-zinc-400">
                Model and reasoning effort for new tasks. Per-task overrides still apply.
              </p>
            </div>
            <span
              aria-live="polite"
              aria-hidden={!defaultsError && !savingDefaults && !savedDefaults}
              className={`shrink-0 text-xs transition-opacity duration-300 ${
                defaultsError || savingDefaults || savedDefaults ? 'opacity-100' : 'opacity-0'
              } ${defaultsError ? 'text-red-500' : 'text-zinc-400 dark:text-zinc-500'}`}
            >
              {defaultsError ?? (savingDefaults ? 'Saving...' : 'Saved')}
            </span>
          </div>

          <div className="mt-4 flex items-center flex-wrap gap-3">
            <ModelPicker
              value={agentDefaults?.model ?? ''}
              provider={agentDefaults?.provider ?? null}
              modelGroups={modelGroups}
              disabled={isLoadingDefaults || savingDefaults}
              title={agentDefaults?.model ? `Default: ${agentDefaults.model}` : 'Select default model'}
              onChange={(nextModel, selection?: ModelPickerSelection) => {
                const parsed = parseQualifiedModelValue(nextModel);
                const provider = selection?.provider ?? parsed?.provider;
                saveDefaults({
                  model: parsed?.model ?? nextModel,
                  ...(provider ? { provider } : {}),
                });
              }}
            />

            <select
              value={agentDefaults?.reasoningEffort ?? 'medium'}
              disabled={isLoadingDefaults || savingDefaults}
              onChange={(event) => saveDefaults({ reasoningEffort: event.target.value as ReasoningEffort })}
              aria-label="Default reasoning effort"
              className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 pr-7 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:focus:ring-zinc-700 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20fill%3D%22none%22%20stroke%3D%22%2371717a%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m3%204.5%203%203%203-3%22%2F%3E%3C%2Fsvg%3E')] bg-[length:12px] bg-[right_0.5rem_center] bg-no-repeat"
            >
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {REASONING_LABELS[effort]}
                </option>
              ))}
            </select>
          </div>
        </section>

        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2">Theme</h2>
          <SegmentedGroup options={themeOptions} value={theme} onChange={setTheme} />
        </div>

        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2">Sound on task completion</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <SegmentedGroup options={soundOptions} value={soundEnabled} onChange={setSoundEnabled} />
            <button
              onClick={playPreview}
              aria-label="Preview sound"
              title="Preview sound"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
            >
              <Play size={14} />
              Preview
            </button>
          </div>
        </div>

        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-2">Version</h2>
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs font-medium text-zinc-900 dark:text-zinc-100">
            <Info size={14} />
            AgentControl
            <span className="text-zinc-500 dark:text-zinc-400">
              {appVersion ? `v${appVersion.version}` : '...'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
