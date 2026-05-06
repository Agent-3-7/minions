import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Code2, Eye, Loader2, RefreshCw } from 'lucide-react';
import { fetchSkillContent, fetchSkills, type SkillMeta } from '../lib/api';
import { toErrorMessage } from '../lib/format';
import { MarkdownContent } from './MarkdownContent';

function stripFrontmatter(content: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

function SkillBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      {children}
    </span>
  );
}

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'view' | 'code'>('view');
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) ?? null;

  const loadSkills = useCallback(async () => {
    setLoadingSkills(true);
    try {
      const { skills: nextSkills } = await fetchSkills();
      setSkills(nextSkills);
      setSelectedSkillId((current) => (
        current && nextSkills.some((skill) => skill.id === current)
          ? current
          : nextSkills[0]?.id ?? null
      ));
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to load skills'));
    } finally {
      setLoadingSkills(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (!selectedSkillId) {
      setContent(null);
      return;
    }

    let cancelled = false;
    setLoadingContent(true);
    fetchSkillContent(selectedSkillId)
      .then(({ content: nextContent }) => {
        if (!cancelled) {
          setContent(nextContent);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setContent(null);
          setError(toErrorMessage(err, 'Failed to load skill content'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingContent(false);
      });

    return () => { cancelled = true; };
  }, [selectedSkillId]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-4 px-6 py-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Skills</h1>
            <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
              Auto-included guidance available to every Hermes task
            </p>
          </div>
          <button
            type="button"
            onClick={loadSkills}
            disabled={loadingSkills}
            title="Refresh skills"
            className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            {loadingSkills ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            <AlertCircle size={15} className="shrink-0" />
            <span className="truncate">{error}</span>
          </div>
        )}

        <div className="grid min-h-[620px] grid-cols-1 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="border-b border-zinc-200 px-3 py-2 text-xs font-medium uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
              Auto-included · {skills.length}
            </div>
            <div className="max-h-[680px] divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">
              {loadingSkills && skills.length === 0 && (
                <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-500 dark:text-zinc-400">
                  <Loader2 size={14} className="animate-spin" />
                  Loading skills
                </div>
              )}
              {!loadingSkills && skills.length === 0 && (
                <div className="px-3 py-10 text-center text-sm text-zinc-400 dark:text-zinc-500">
                  No bundled skills found.
                </div>
              )}
              {skills.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => setSelectedSkillId(skill.id)}
                  className={`w-full px-3 py-3 text-left transition-colors ${
                    selectedSkillId === skill.id
                      ? 'bg-zinc-100 dark:bg-zinc-800'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {skill.name}
                      </p>
                      <p className="mt-1 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
                        {skill.description || 'No description provided.'}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <SkillBadge>Bundled</SkillBadge>
                    <SkillBadge>Auto-included</SkillBadge>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            {!selectedSkill ? (
              <div className="flex h-full items-center justify-center text-sm text-zinc-400 dark:text-zinc-500">
                Select a skill.
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
                        {selectedSkill.name}
                      </h2>
                      <p className="mt-0.5 truncate text-xs font-mono text-zinc-400 dark:text-zinc-500">
                        {selectedSkill.key}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                      Auto-included
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
                    <div>
                      <p className="text-zinc-400 dark:text-zinc-500">Source</p>
                      <p className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">{selectedSkill.source}</p>
                    </div>
                    <div>
                      <p className="text-zinc-400 dark:text-zinc-500">Mode</p>
                      <p className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">Read only</p>
                    </div>
                    <div>
                      <p className="text-zinc-400 dark:text-zinc-500">Runtime</p>
                      <p className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">Available</p>
                    </div>
                    <div>
                      <p className="text-zinc-400 dark:text-zinc-500">File</p>
                      <p className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">SKILL.md</p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
                  <span className="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {selectedSkill.description || 'No description provided.'}
                  </span>
                  <div className="flex shrink-0 overflow-hidden rounded-md border border-zinc-200 text-xs dark:border-zinc-700">
                    <button
                      type="button"
                      onClick={() => setViewMode('view')}
                      className={`inline-flex h-8 items-center gap-1.5 px-2.5 font-medium transition-colors ${
                        viewMode === 'view'
                          ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100'
                          : 'text-zinc-500 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800'
                      }`}
                    >
                      <Eye size={13} />
                      View
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('code')}
                      className={`inline-flex h-8 items-center gap-1.5 border-l border-zinc-200 px-2.5 font-medium transition-colors dark:border-zinc-700 ${
                        viewMode === 'code'
                          ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100'
                          : 'text-zinc-500 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800'
                      }`}
                    >
                      <Code2 size={13} />
                      Code
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                  {loadingContent && (
                    <div className="flex items-center gap-2 py-4 text-sm text-zinc-500 dark:text-zinc-400">
                      <Loader2 size={14} className="animate-spin" />
                      Loading skill
                    </div>
                  )}
                  {!loadingContent && !content && (
                    <p className="text-sm text-zinc-400 dark:text-zinc-500">No content available.</p>
                  )}
                  {!loadingContent && content && viewMode === 'view' && (
                    <MarkdownContent content={stripFrontmatter(content)} />
                  )}
                  {!loadingContent && content && viewMode === 'code' && (
                    <pre className="whitespace-pre-wrap break-words rounded-lg bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-100">
                      {content}
                    </pre>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
