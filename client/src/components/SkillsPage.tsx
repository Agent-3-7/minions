import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  AlertCircle,
  CheckCircle2,
  Code2,
  Download,
  ExternalLink,
  Eye,
  FolderUp,
  Loader2,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  browseClawHubSkills,
  deleteSkill,
  fetchClawHubSkillContent,
  fetchClawHubSkillScan,
  fetchSkillContent,
  fetchSkills,
  importSkillFiles,
  installSkill,
  searchClawHubSkills,
  type SkillMeta,
} from '../lib/api';
import type { ClawHubScanResult, ClawHubSkillSummary, ClawHubStats } from '@shared/types';
import { toErrorMessage } from '../lib/format';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { usePageHeader, type PageHeaderConfig } from './Header';
import { MarkdownContent } from './MarkdownContent';

type SkillMode = 'browse' | 'installed';
type ViewMode = 'view' | 'code';
type PreviewState =
  | { type: 'registry'; skill: ClawHubSkillSummary }
  | { type: 'installed'; skill: SkillMeta };

const DEFAULT_BROWSE_SKILL_LIMIT = 8;
const SEARCH_SKILL_LIMIT = 24;

// Shared "dark primary" button look (zinc-900 / zinc-100), composed with
// per-site layout classes.
const primaryButtonClass = 'bg-zinc-900 text-white transition-colors hover:bg-zinc-700 disabled:cursor-default disabled:bg-zinc-200 disabled:text-zinc-500 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500';

function isSkillMode(value: string | undefined): value is SkillMode {
  return value === 'browse' || value === 'installed';
}

function stripFrontmatter(content: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

function latestVersion(skill: ClawHubSkillSummary | null | undefined): string | null {
  return skill?.latestVersion ?? skill?.version ?? null;
}

function formatNumber(value: number | null | undefined): string {
  if (value == null) return '0';
  return new Intl.NumberFormat(undefined, { notation: value >= 10000 ? 'compact' : 'standard' }).format(value);
}

function formatDate(value: number | string | null | undefined): string {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function registryCountLabel(stats: ClawHubStats | null | undefined): { value: string; label: string } {
  if (stats?.installsAllTime != null) return { value: formatNumber(stats.installsAllTime), label: 'installs' };
  if (stats?.downloads != null) return { value: formatNumber(stats.downloads), label: 'downloads' };
  if (stats?.installsCurrent != null) return { value: formatNumber(stats.installsCurrent), label: 'installs' };
  return { value: '0', label: 'installs' };
}

function scanDisplay(scan: ClawHubScanResult | null): { label: string; className: string; icon: ReactNode } {
  const status = scan?.security?.status?.toLowerCase();
  const hasWarnings = scan?.security?.hasWarnings;
  if (status === 'clean' && !hasWarnings) {
    return {
      label: 'Clean scan',
      className: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
      icon: <ShieldCheck size={14} />,
    };
  }
  if (status === 'clean') {
    return {
      label: 'Scan notes',
      className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300',
      icon: <ShieldAlert size={14} />,
    };
  }
  if (status) {
    return {
      label: status,
      className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300',
      icon: <ShieldAlert size={14} />,
    };
  }
  return {
    label: 'Scan unavailable',
    className: 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
    icon: <ShieldAlert size={14} />,
  };
}

function stopCardClick(event: MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

function fileRelativePath(file: File): string {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relativePath && relativePath.length > 0 ? relativePath : file.name;
}

async function collectDroppedEntry(
  entry: FileSystemEntry,
  out: { file: File; path: string }[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ file, path: entry.fullPath.replace(/^\/+/, '') });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries yields the directory in batches; loop until it returns none.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await collectDroppedEntry(child, out);
    }
  }
}

// A dropped folder is not expanded by dataTransfer.files; walk the directory
// entries (captured synchronously before any await) so folder drag-and-drop
// imports the whole tree, tagging each file with its folder-relative path.
async function filesFromDrop(
  dataTransfer: DataTransfer,
): Promise<{ files: File[]; paths: Map<File, string> }> {
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const entries = items
    .filter((item) => item.kind === 'file' && typeof item.webkitGetAsEntry === 'function')
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry != null);

  if (entries.length === 0) {
    return { files: Array.from(dataTransfer.files), paths: new Map() };
  }

  const collected: { file: File; path: string }[] = [];
  for (const entry of entries) await collectDroppedEntry(entry, collected);

  const paths = new Map<File, string>();
  for (const item of collected) paths.set(item.file, item.path);
  return { files: collected.map((item) => item.file), paths };
}

function filesSummary(files: File[], relativePathFor: (file: File) => string = fileRelativePath): string {
  if (files.length === 0) return 'No files selected';
  if (files.length === 1) return files[0].name;
  const firstPath = relativePathFor(files[0]);
  const root = firstPath.includes('/') ? firstPath.split('/')[0] : null;
  return root ? `${root} · ${files.length} files` : `${files.length} files selected`;
}

function ErrorBanner({ message, className = '' }: { message: string; className?: string }) {
  return (
    <div className={`flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300 ${className}`}>
      <AlertCircle size={15} className="shrink-0" />
      <span className="min-w-0">{message}</span>
    </div>
  );
}

function SkillCardShell({ onOpen, children }: { onOpen: () => void; children: ReactNode }) {
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group flex min-h-[132px] cursor-pointer flex-col rounded-lg border border-zinc-200 bg-white px-4 py-3.5 text-left transition-[border-color,box-shadow] hover:border-zinc-300 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:focus:ring-zinc-700"
    >
      {children}
    </article>
  );
}

function ModeButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 rounded-md px-3.5 text-xs font-medium transition-colors ${
        active
          ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
      }`}
    >
      {children}
    </button>
  );
}

function ViewModeToggle({ viewMode, setViewMode }: { viewMode: ViewMode; setViewMode: (mode: ViewMode) => void }) {
  return (
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
  );
}

function LoadingState({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-zinc-200 bg-white px-3 py-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      <Loader2 size={14} className="animate-spin" />
      {children}
    </div>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="col-span-full flex min-h-[260px] flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex size-10 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
        <Search size={18} />
      </div>
      <h3 className="mt-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
      <p className="mt-1 max-w-sm text-sm leading-6 text-zinc-500 dark:text-zinc-400">{description}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={`mt-4 inline-flex h-9 items-center rounded-lg px-3 text-xs font-medium ${primaryButtonClass}`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function RegistrySkillCard({
  skill,
  installed,
  installing,
  installDisabled,
  onOpen,
  onInstall,
}: {
  skill: ClawHubSkillSummary;
  installed: boolean;
  installing: boolean;
  installDisabled: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const count = registryCountLabel(skill.stats);
  const version = latestVersion(skill);

  return (
    <SkillCardShell onOpen={onOpen}>
      <div className="flex items-baseline gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{skill.displayName}</h3>
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">ClawHub</span>
        <a
          href={`https://clawhub.ai/skills/${encodeURIComponent(skill.slug)}`}
          target="_blank"
          rel="noreferrer"
          title="Open in ClawHub"
          onClick={stopCardClick}
          className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <ExternalLink size={13} />
        </a>
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
        {skill.summary || 'No description provided.'}
      </p>
      <div className="mt-auto flex items-center gap-3 pt-3 text-[11px] text-zinc-400 dark:text-zinc-500">
        <span><b className="font-semibold text-zinc-600 dark:text-zinc-300">{count.value}</b> {count.label}</span>
        {skill.stats?.stars != null && (
          <span className="inline-flex items-center gap-1">
            <Star size={11} />
            {formatNumber(skill.stats.stars)}
          </span>
        )}
        {version && <span>v{version}</span>}
        <button
          type="button"
          title={installed ? `${skill.displayName} is installed` : `Install ${skill.displayName}`}
          aria-label={installed ? `${skill.displayName} is installed` : `Install ${skill.displayName}`}
          onClick={(event) => {
            stopCardClick(event);
            onInstall();
          }}
          disabled={installed || installDisabled}
          className={`ml-auto inline-flex h-7 min-w-[88px] shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-[11px] font-semibold ${
            installed
              ? 'bg-zinc-100 text-zinc-600 transition-colors disabled:cursor-default dark:bg-zinc-800 dark:text-zinc-300'
              : primaryButtonClass
          }`}
        >
          {installing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : installed ? (
            <CheckCircle2 size={12} />
          ) : (
            <Download size={12} />
          )}
          {installing ? 'Installing' : installed ? 'Installed' : 'Install'}
        </button>
      </div>
    </SkillCardShell>
  );
}

function InstalledSkillCard({
  skill,
  deleting,
  onOpen,
  onDelete,
}: {
  skill: SkillMeta;
  deleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <SkillCardShell onOpen={onOpen}>
      <div className="flex items-baseline gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{skill.name}</h3>
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{skill.source}</span>
        <button
          type="button"
          title={`Delete ${skill.name}`}
          onClick={(event) => {
            stopCardClick(event);
            onDelete();
          }}
          disabled={deleting}
          className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 focus:opacity-100 disabled:cursor-default disabled:opacity-40 dark:text-zinc-500 dark:hover:bg-red-950/30 dark:hover:text-red-300"
        >
          {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
        </button>
        {skill.registrySlug && (
          <a
            href={`https://clawhub.ai/skills/${encodeURIComponent(skill.registrySlug)}`}
            target="_blank"
            rel="noreferrer"
            title="Open in ClawHub"
            onClick={stopCardClick}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus:opacity-100 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <ExternalLink size={13} />
          </a>
        )}
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-zinc-600 dark:text-zinc-400">
        {skill.description || 'No description provided.'}
      </p>
      <div className="mt-auto flex items-center gap-3 pt-3 text-[11px] text-zinc-400 dark:text-zinc-500">
        <span>Imported</span>
        <span>{formatDate(skill.installedAt)}</span>
        {skill.version && <span>v{skill.version}</span>}
        <span className="ml-auto rounded-md bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          Installed
        </span>
      </div>
    </SkillCardShell>
  );
}

function AddSkillModal({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (skill: SkillMeta) => void;
}) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const droppedPathsRef = useRef<Map<File, string>>(new Map());
  const [files, setFiles] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The modal is always mounted but renders null while closed, so the folder
    // input only exists once `open` is true — re-run then to apply the
    // directory-picker attributes (an empty dep array would no-op on a null ref).
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, [open]);

  useEffect(() => {
    if (!open) {
      setFiles([]);
      setDragActive(false);
      setImporting(false);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  function resolveRelativePath(file: File): string {
    return droppedPathsRef.current.get(file) ?? fileRelativePath(file);
  }

  function selectFiles(nextFiles: FileList | File[], paths?: Map<File, string>) {
    const next = Array.from(nextFiles);
    if (next.length === 0) return;
    droppedPathsRef.current = paths ?? new Map();
    setFiles(next);
    setError(null);
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) selectFiles(event.target.files);
    event.target.value = '';
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    try {
      const { files: dropped, paths } = await filesFromDrop(event.dataTransfer);
      if (dropped.length > 0) selectFiles(dropped, paths);
    } catch {
      setError('Could not read the dropped folder. Try the "Browse folder" button instead.');
    }
  }

  async function handleImport() {
    if (files.length === 0 || importing) return;
    setImporting(true);
    setError(null);
    try {
      const result = await importSkillFiles(files, resolveRelativePath);
      toast('Skill imported');
      onImported(result.skill);
      onClose();
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to import skill'));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-5"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !importing) onClose();
      }}
    >
      <div className="w-full max-w-[460px] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
        <header className="flex items-start justify-between gap-4 border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Add a skill</h2>
            <p className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">Upload a local skill folder or .zip.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={importing}
            title="Close"
            className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <X size={16} />
          </button>
        </header>

        <div className="px-5 py-4">
          <input ref={folderInputRef} type="file" multiple className="hidden" onChange={handleInputChange} />
          <input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={handleInputChange} />

          {files.length === 0 ? (
            <div
              onDragEnter={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              className={`rounded-xl border border-dashed px-5 py-7 text-center transition-colors ${
                dragActive
                  ? 'border-zinc-500 bg-zinc-100 dark:border-zinc-400 dark:bg-zinc-800'
                  : 'border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950/50'
              }`}
            >
              <div className="mx-auto flex size-10 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                <Upload size={18} />
              </div>
              <b className="mt-3 block text-sm text-zinc-800 dark:text-zinc-100">Drop a skill folder or .zip here</b>
              <span className="mt-1 block text-xs text-zinc-400 dark:text-zinc-500">
                must contain a root SKILL.md
              </span>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <FolderUp size={14} />
                  Browse folder
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <Upload size={14} />
                  Choose .zip
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/50">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                <CheckCircle2 size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                  {filesSummary(files, resolveRelativePath)}
                </div>
                <div className="text-xs text-zinc-400 dark:text-zinc-500">Ready to upload</div>
              </div>
              <button
                type="button"
                onClick={() => setFiles([])}
                title="Remove"
                className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <X size={15} />
              </button>
            </div>
          )}

          {error && <ErrorBanner message={error} className="mt-3" />}
        </div>

        <footer className="flex justify-end gap-2 border-t border-zinc-100 bg-zinc-50 px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
          <button
            type="button"
            onClick={onClose}
            disabled={importing}
            className="inline-flex h-9 items-center rounded-lg border border-zinc-200 bg-white px-3 text-xs font-semibold text-zinc-800 transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={files.length === 0 || importing}
            className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold ${primaryButtonClass}`}
          >
            {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            Upload
          </button>
        </footer>
      </div>
    </div>
  );
}

function SkillPreviewModal({
  preview,
  content,
  scan,
  loading,
  error,
  viewMode,
  setViewMode,
  installed,
  installing,
  onInstall,
  onClose,
}: {
  preview: PreviewState | null;
  content: string | null;
  scan: ClawHubScanResult | null;
  loading: boolean;
  error: string | null;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
  onClose: () => void;
}) {
  if (!preview) return null;

  const isRegistry = preview.type === 'registry';
  const title = isRegistry ? preview.skill.displayName : preview.skill.name;
  const description = isRegistry ? preview.skill.summary : preview.skill.description;
  const version = isRegistry ? latestVersion(preview.skill) : preview.skill.version;
  const count = isRegistry ? registryCountLabel(preview.skill.stats) : null;
  const scanInfo = scanDisplay(scan);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-5"
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-[86dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
        <header className="border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
                <span className="shrink-0 rounded-md bg-zinc-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {isRegistry ? 'ClawHub' : preview.skill.source}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">
                {description || 'No description provided.'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {isRegistry && (
                <a
                  href={`https://clawhub.ai/skills/${encodeURIComponent(preview.skill.slug)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 px-3 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                >
                  <ExternalLink size={14} />
                  ClawHub
                </a>
              )}
              {isRegistry && (
                <button
                  type="button"
                  onClick={onInstall}
                  disabled={installed || installing}
                  className={`inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium ${primaryButtonClass}`}
                >
                  {installing ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : installed ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <Download size={14} />
                  )}
                  {installed ? 'Installed' : 'Install'}
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                title="Close"
                className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
            <div>
              <p className="text-zinc-400 dark:text-zinc-500">Source</p>
              <p className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">{isRegistry ? 'ClawHub' : preview.skill.source}</p>
            </div>
            <div>
              <p className="text-zinc-400 dark:text-zinc-500">Version</p>
              <p className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">{version ?? (isRegistry ? 'Latest' : 'Local')}</p>
            </div>
            <div>
              <p className="text-zinc-400 dark:text-zinc-500">{isRegistry ? count?.label ?? 'Installs' : 'Installed'}</p>
              <p className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">{isRegistry ? count?.value ?? '0' : formatDate(preview.skill.installedAt)}</p>
            </div>
            <div>
              <p className="text-zinc-400 dark:text-zinc-500">{isRegistry ? 'Updated' : 'Runtime'}</p>
              <p className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">{isRegistry ? formatDate(preview.skill.updatedAt) : 'Hermes external dir'}</p>
            </div>
          </div>

          {isRegistry && (
            <div className="mt-3 flex flex-wrap gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium ${scanInfo.className}`}>
                {scanInfo.icon}
                {scanInfo.label}
              </span>
            </div>
          )}
        </header>

        <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-5 py-2.5 dark:border-zinc-800">
          <span className="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400">SKILL.md</span>
          <ViewModeToggle viewMode={viewMode} setViewMode={setViewMode} />
        </div>

        <div className="min-h-[260px] flex-1 overflow-y-auto px-5 py-4">
          {error && <ErrorBanner message={error} className="mb-4" />}
          {loading && (
            <div className="flex items-center gap-2 py-4 text-sm text-zinc-500 dark:text-zinc-400">
              <Loader2 size={14} className="animate-spin" />
              Loading skill
            </div>
          )}
          {!loading && !content && !error && (
            <p className="text-sm text-zinc-400 dark:text-zinc-500">No content available.</p>
          )}
          {!loading && content && viewMode === 'view' && (
            <MarkdownContent content={stripFrontmatter(content)} />
          )}
          {!loading && content && viewMode === 'code' && (
            <pre className="whitespace-pre-wrap break-words rounded-lg bg-zinc-950 p-4 text-xs leading-relaxed text-zinc-100">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function SkillsPage() {
  const navigate = useNavigate();
  const { tab } = useParams<{ tab?: string }>();
  const mode: SkillMode = isSkillMode(tab) ? tab : 'browse';
  const [query, setQuery] = useState('');
  const [addModalOpen, setAddModalOpen] = useState(false);

  const [installedSkills, setInstalledSkills] = useState<SkillMeta[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [installedError, setInstalledError] = useState<string | null>(null);

  const [registrySkills, setRegistrySkills] = useState<ClawHubSkillSummary[]>([]);
  const [loadingRegistry, setLoadingRegistry] = useState(true);
  const [registryError, setRegistryError] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewScan, setPreviewScan] = useState<ClawHubScanResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewViewMode, setPreviewViewMode] = useState<ViewMode>('view');
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [skillToDelete, setSkillToDelete] = useState<SkillMeta | null>(null);
  const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const registryRequestRef = useRef(0);

  const setMode = useCallback((nextMode: SkillMode) => {
    if (nextMode !== mode) navigate(`/skills/${nextMode}`);
  }, [mode, navigate]);

  const headerActions = useMemo(() => (
    <button
      type="button"
      onClick={() => setAddModalOpen(true)}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium ${primaryButtonClass}`}
    >
      <Plus size={14} />
      Add skill
    </button>
  ), []);
  const headerConfig = useMemo<PageHeaderConfig>(() => ({
    crumbs: [
      { label: 'Skills', to: '/skills/browse' },
      { label: mode === 'browse' ? 'Browse' : 'Installed' },
    ],
    actions: headerActions,
  }), [headerActions, mode]);
  usePageHeader(headerConfig);

  const installedSlugs = useMemo(() => (
    new Set(installedSkills.flatMap((skill) => (
      skill.provider === 'clawhub' && skill.registrySlug ? [skill.registrySlug] : []
    )))
  ), [installedSkills]);

  const filteredInstalledSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return installedSkills;
    return installedSkills.filter((skill) => (
      skill.name.toLowerCase().includes(needle)
      || skill.description.toLowerCase().includes(needle)
      || skill.source.toLowerCase().includes(needle)
      || skill.key.toLowerCase().includes(needle)
    ));
  }, [installedSkills, query]);

  const loadInstalledSkills = useCallback(async (): Promise<SkillMeta[]> => {
    setLoadingInstalled(true);
    try {
      const { skills } = await fetchSkills();
      setInstalledSkills(skills);
      setInstalledError(null);
      return skills;
    } catch (err) {
      setInstalledError(toErrorMessage(err, 'Failed to load installed skills'));
      return [];
    } finally {
      setLoadingInstalled(false);
    }
  }, []);

  const loadRegistrySkills = useCallback(async (search: string): Promise<void> => {
    const requestId = registryRequestRef.current + 1;
    registryRequestRef.current = requestId;
    setLoadingRegistry(true);
    setRegistrySkills([]);
    setRegistryError(null);
    try {
      const skills = search.trim()
        ? await searchClawHubSkills(search.trim(), SEARCH_SKILL_LIMIT)
        : await browseClawHubSkills(DEFAULT_BROWSE_SKILL_LIMIT);
      if (registryRequestRef.current !== requestId) return;
      setRegistrySkills(skills);
      setRegistryError(null);
    } catch (err) {
      if (registryRequestRef.current !== requestId) return;
      setRegistrySkills([]);
      setRegistryError(toErrorMessage(err, 'Failed to load ClawHub skills'));
    } finally {
      if (registryRequestRef.current === requestId) setLoadingRegistry(false);
    }
  }, []);

  useEffect(() => {
    void loadInstalledSkills();
  }, [loadInstalledSkills]);

  useEffect(() => {
    if (!isSkillMode(tab)) navigate('/skills/browse', { replace: true });
  }, [navigate, tab]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadRegistrySkills(query);
    }, query.trim() ? 250 : 0);
    return () => window.clearTimeout(timeout);
  }, [loadRegistrySkills, query]);

  useEffect(() => {
    if (!preview) {
      setPreviewContent(null);
      setPreviewScan(null);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    setPreviewViewMode('view');
    setPreviewLoading(true);
    setPreviewContent(null);
    setPreviewScan(null);
    setPreviewError(null);

    if (preview.type === 'registry') {
      const { slug } = preview.skill;
      Promise.all([
        fetchClawHubSkillContent(slug),
        fetchClawHubSkillScan(slug).catch(() => null),
      ])
        .then(([content, scanResult]) => {
          if (cancelled) return;
          setPreviewContent(content);
          setPreviewScan(scanResult);
        })
        .catch((err) => {
          if (!cancelled) setPreviewError(toErrorMessage(err, 'Failed to load skill'));
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    } else {
      fetchSkillContent(preview.skill.id)
        .then(({ content }) => {
          if (!cancelled) setPreviewContent(content);
        })
        .catch((err) => {
          if (!cancelled) setPreviewError(toErrorMessage(err, 'Failed to load skill'));
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }

    return () => { cancelled = true; };
  }, [preview]);

  async function handleInstall(skill: ClawHubSkillSummary, options: { openInstalledPreview?: boolean } = {}) {
    if (installingSlug) return;
    const { openInstalledPreview = true } = options;
    setInstallingSlug(skill.slug);
    try {
      const result = await installSkill({ provider: 'clawhub', slug: skill.slug, version: 'latest' });
      toast(result.alreadyInstalled ? 'Skill already installed' : 'Skill installed');
      await loadInstalledSkills();
      if (openInstalledPreview) {
        setMode('installed');
        setPreview({ type: 'installed', skill: result.skill });
      }
    } catch (err) {
      toast.error(toErrorMessage(err, 'Failed to install skill'));
    } finally {
      setInstallingSlug(null);
    }
  }

  async function handleImported(skill: SkillMeta) {
    await loadInstalledSkills();
    setMode('installed');
    setPreview({ type: 'installed', skill });
  }

  async function handleDeleteSkill() {
    if (!skillToDelete || deletingSkillId) return;
    setDeletingSkillId(skillToDelete.id);
    setDeleteError(null);
    try {
      const deletedId = skillToDelete.id;
      await deleteSkill(deletedId);
      toast('Skill deleted');
      setSkillToDelete(null);
      if (preview?.type === 'installed' && preview.skill.id === deletedId) {
        setPreview(null);
      }
      await loadInstalledSkills();
    } catch (err) {
      setDeleteError(toErrorMessage(err, 'Failed to delete skill'));
    } finally {
      setDeletingSkillId(null);
    }
  }

  const visibleSkills = mode === 'browse' ? registrySkills : filteredInstalledSkills;
  const topError = mode === 'browse' ? registryError : installedError;
  const isLoading = mode === 'browse' ? loadingRegistry : loadingInstalled;
  const previewInstalled = preview?.type === 'registry' ? installedSlugs.has(preview.skill.slug) : true;

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-50 dark:bg-zinc-950/20">
      <div className="mx-auto max-w-[1040px] px-4 py-3 pb-20 sm:px-5">
        <div className="mb-3 flex items-center gap-2.5 max-sm:flex-col max-sm:items-stretch">
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500">
            <Search size={15} className="shrink-0" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills..."
              className="min-w-0 flex-1 bg-transparent text-base text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
            />
          </div>
          <div className="inline-flex h-10 shrink-0 items-center gap-0.5 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
            <ModeButton active={mode === 'browse'} onClick={() => setMode('browse')}>
              Browse
            </ModeButton>
            <ModeButton active={mode === 'installed'} onClick={() => setMode('installed')}>
              Installed · {installedSkills.length}
            </ModeButton>
          </div>
        </div>

        {topError && <ErrorBanner message={topError} className="mb-4" />}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {isLoading && visibleSkills.length === 0 && (
            <div className="col-span-full">
              <LoadingState>{mode === 'browse' ? 'Loading ClawHub skills' : 'Loading installed skills'}</LoadingState>
            </div>
          )}

          {!isLoading && mode === 'browse' && registrySkills.length === 0 && (
            <EmptyState
              title="No matching skills"
              description="Try a broader search term, or clear the search to browse popular ClawHub skills."
            />
          )}

          {!isLoading && mode === 'installed' && filteredInstalledSkills.length === 0 && (
            <EmptyState
              title={installedSkills.length === 0 ? 'No installed skills' : 'No matching installed skills'}
              description={installedSkills.length === 0
                ? 'Install a skill from ClawHub or import a local skill folder.'
                : 'Try a broader search term or switch back to Browse.'}
              action={installedSkills.length === 0 ? { label: 'Browse skills', onClick: () => setMode('browse') } : undefined}
            />
          )}

          {mode === 'browse' && registrySkills.map((skill) => (
            <RegistrySkillCard
              key={skill.slug}
              skill={skill}
              installed={installedSlugs.has(skill.slug)}
              installing={installingSlug === skill.slug}
              installDisabled={installingSlug !== null}
              onOpen={() => setPreview({ type: 'registry', skill })}
              onInstall={() => void handleInstall(skill, { openInstalledPreview: false })}
            />
          ))}

          {mode === 'installed' && filteredInstalledSkills.map((skill) => (
            <InstalledSkillCard
              key={skill.id}
              skill={skill}
              deleting={deletingSkillId === skill.id}
              onOpen={() => setPreview({ type: 'installed', skill })}
              onDelete={() => {
                setSkillToDelete(skill);
                setDeleteError(null);
              }}
            />
          ))}
        </div>
      </div>

      <AddSkillModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onImported={handleImported}
      />

      <SkillPreviewModal
        preview={preview}
        content={previewContent}
        scan={previewScan}
        loading={previewLoading}
        error={previewError}
        viewMode={previewViewMode}
        setViewMode={setPreviewViewMode}
        installed={previewInstalled}
        installing={preview?.type === 'registry' && installingSlug === preview.skill.slug}
        onInstall={() => {
          if (preview?.type === 'registry') void handleInstall(preview.skill);
        }}
        onClose={() => setPreview(null)}
      />

      {skillToDelete && (
        <DeleteConfirmModal
          title="Delete skill"
          body={`This removes "${skillToDelete.name}" from ~/.minions/skills. Future agent runs will no longer include it.`}
          confirmLabel="Delete skill"
          isConfirming={deletingSkillId === skillToDelete.id}
          error={deleteError}
          onCancel={() => {
            if (deletingSkillId) return;
            setSkillToDelete(null);
            setDeleteError(null);
          }}
          onConfirm={() => void handleDeleteSkill()}
        />
      )}
    </div>
  );
}
