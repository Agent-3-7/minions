import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  Info,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { FileCreateType, FileEntry, FileListResponse, FileReadResponse } from '@shared/types';
import {
  ApiError,
  createFileEntry,
  deleteFileEntry,
  fileDownloadUrl,
  listFiles,
  readFile,
  renameFileEntry,
  uploadFileEntries,
  WORKSPACE_ROOT,
  writeFile,
} from '../lib/api';
import { formatBytes, formatDate, toErrorMessage } from '../lib/format';
import { isEditableTarget } from '../lib/keyboard';
import { CsvEditor } from './CsvEditor';
import { DeleteConfirmModal } from './DeleteConfirmModal';

const FILE_LIST_GRID = 'grid-cols-[minmax(180px,1fr)_140px_90px_130px] max-md:grid-cols-[minmax(0,1fr)_84px]';

type DeleteDialog = {
  entry: FileEntry;
  busy: boolean;
  error: string | null;
};

type InlineNameBase = { name: string; busy: boolean; error: string | null };
type InlineNameOperation =
  | (InlineNameBase & { mode: 'create'; type: FileCreateType })
  | (InlineNameBase & { mode: 'rename'; entry: FileEntry });

type ContextMenu =
  | { kind: 'empty'; x: number; y: number }
  | { kind: 'entry'; x: number; y: number; entry: FileEntry };

type HistoryMode = 'push' | 'back' | 'forward';

export function FileBrowserPage() {
  const fileUploadInputRef = useRef<HTMLInputElement>(null);
  const folderUploadInputRef = useRef<HTMLInputElement>(null);
  const inlineNameInputRef = useRef<HTMLInputElement>(null);
  const fileListScrollTopRef = useRef(0);
  const [directory, setDirectory] = useState<FileListResponse | null>(null);
  const [pathInput, setPathInput] = useState(WORKSPACE_ROOT);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [openFile, setOpenFile] = useState<FileReadResponse | null>(null);
  const [content, setContent] = useState('');
  const [loadingDirectory, setLoadingDirectory] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [inlineName, setInlineName] = useState<InlineNameOperation | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialog | null>(null);
  const [infoEntry, setInfoEntry] = useState<FileEntry | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [backStack, setBackStack] = useState<string[]>([]);
  const [forwardStack, setForwardStack] = useState<string[]>([]);

  const isDirty = openFile ? content !== openFile.content : false;
  const selectedPath = selectedEntry?.path ?? null;
  const downloadTargetPath = selectedEntry?.path ?? directory?.path ?? null;
  const breadcrumbLabel = parentBreadcrumbLabel(directory);
  const inlineNameKey = inlineName
    ? inlineName.mode === 'rename'
      ? `rename:${inlineName.entry.path}`
      : `create:${inlineName.type}`
    : null;

  const loadDirectory = useCallback(async (targetPath: string, reportError = true) => {
    setLoadingDirectory(true);
    try {
      const nextDirectory = await listFiles(targetPath);
      setDirectory(nextDirectory);
      setPathInput(nextDirectory.path);
      setError(null);
      return nextDirectory;
    } catch (err) {
      if (reportError) setError(toErrorMessage(err, 'Failed to load directory'));
      throw err;
    } finally {
      setLoadingDirectory(false);
    }
  }, []);

  const closeOpenFile = useCallback(() => {
    setOpenFile(null);
    setContent('');
    setFileError(null);
    setConflict(false);
  }, []);

  const applyOpenFile = useCallback((file: FileReadResponse, entry?: FileEntry) => {
    setOpenFile(file);
    setContent(file.content);
    setSelectedEntry(entry ?? entryFromReadResponse(file));
    setFileError(null);
    setConflict(false);
    setError(null);
    setInlineName(null);
    setContextMenu(null);
  }, []);

  const openTextFile = useCallback(async (targetPath: string, entry?: FileEntry) => {
    setLoadingFile(true);
    try {
      const file = await readFile(targetPath);
      applyOpenFile(file, entry);
      return file;
    } catch (err) {
      setOpenFile(null);
      setContent('');
      setSelectedEntry(entry ?? null);
      setFileError(toErrorMessage(err, 'Failed to open file'));
      throw err;
    } finally {
      setLoadingFile(false);
    }
  }, [applyOpenFile]);

  useEffect(() => {
    loadDirectory(WORKSPACE_ROOT).catch(() => undefined);
  }, [loadDirectory]);

  useEffect(() => {
    folderUploadInputRef.current?.setAttribute('webkitdirectory', '');
    folderUploadInputRef.current?.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    if (!inlineName) return;
    const id = window.requestAnimationFrame(() => {
      inlineNameInputRef.current?.focus();
      inlineNameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [inlineNameKey]);

  async function navigateToDirectory(
    targetPath: string,
    mode: HistoryMode = 'push',
    reportError = true,
  ): Promise<boolean> {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return false;

    const previousPath = directory?.path ?? null;
    try {
      const nextDirectory = await loadDirectory(targetPath, reportError);
      closeOpenFile();
      setSelectedEntry(null);
      setInlineName(null);
      setContextMenu(null);
      fileListScrollTopRef.current = 0;

      if (previousPath && previousPath !== nextDirectory.path) {
        if (mode === 'push') {
          setBackStack((stack) => [...stack, previousPath]);
          setForwardStack([]);
        } else if (mode === 'back') {
          setBackStack((stack) => stack.slice(0, -1));
          setForwardStack((stack) => [...stack, previousPath]);
        } else if (mode === 'forward') {
          setForwardStack((stack) => stack.slice(0, -1));
          setBackStack((stack) => [...stack, previousPath]);
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  async function handleBack() {
    const targetPath = backStack[backStack.length - 1];
    if (targetPath) await navigateToDirectory(targetPath, 'back');
  }

  async function handleForward() {
    const targetPath = forwardStack[forwardStack.length - 1];
    if (targetPath) await navigateToDirectory(targetPath, 'forward');
  }

  async function handleUp() {
    if (directory?.parentPath) await navigateToDirectory(directory.parentPath);
  }

  async function handleEntryOpen(entry: FileEntry) {
    setContextMenu(null);
    if (openFile?.path !== entry.path && isDirty && !window.confirm('Discard unsaved changes?')) return;

    if (entry.type === 'directory') {
      await navigateToDirectory(entry.path);
      return;
    }

    if (entry.type === 'symlink') {
      const navigated = await navigateToDirectory(entry.path, 'push', false);
      if (navigated) return;
    }

    await openTextFile(entry.path, entry).catch(() => undefined);
  }

  function selectEntry(entry: FileEntry) {
    setSelectedEntry(entry);
    setFileError(null);
  }

  function handleDownload(targetPath = downloadTargetPath) {
    if (!targetPath) return;
    if (
      openFile
      && isDirty
      && targetPath === openFile.path
      && !window.confirm('Download the saved file from disk? Unsaved edits are not included.')
    ) {
      return;
    }

    const link = document.createElement('a');
    link.href = fileDownloadUrl(targetPath);
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function openUploadPicker(type: 'files' | 'folder') {
    setUploadMenuOpen(false);
    setContextMenu(null);
    if (type === 'folder') folderUploadInputRef.current?.click();
    else fileUploadInputRef.current?.click();
  }

  async function handleUploadInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!directory || files.length === 0) return;

    setUploading(true);
    setError(null);
    try {
      await uploadFileEntries(directory.path, files);
      await loadDirectory(directory.path, false);
      if (openFile && !isDirty) {
        await openTextFile(openFile.path, selectedEntry ?? undefined).catch(() => undefined);
      }
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to upload files'));
    } finally {
      setUploading(false);
    }
  }

  async function handleSave(overwrite = false) {
    if (!openFile || !isDirty) return;

    setSaving(true);
    try {
      const result = await writeFile(openFile.path, content, openFile.modifiedAt, overwrite);
      setOpenFile({
        ...openFile,
        content,
        size: result.size,
        modifiedAt: result.modifiedAt,
        displayPath: result.displayPath,
      });
      setConflict(false);
      setFileError(null);
      if (directory) await loadDirectory(directory.path, false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        setFileError('File changed on disk. Save again to overwrite.');
      } else {
        setFileError(toErrorMessage(err, 'Failed to save file'));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDiscard() {
    if (!openFile) return;
    await openTextFile(openFile.path, selectedEntry ?? undefined).catch(() => undefined);
  }

  async function handlePathSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetPath = pathInput.trim() || WORKSPACE_ROOT;
    await navigateToDirectory(targetPath);
  }

  function resetPathInput() {
    setPathInput(directory?.path ?? WORKSPACE_ROOT);
  }

  function handleCloseEditor() {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    closeOpenFile();
  }

  function startInlineCreate(type: FileCreateType) {
    if (!directory) return;
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;

    closeOpenFile();
    setSelectedEntry(null);
    setContextMenu(null);
    setFileError(null);
    setInlineName({
      mode: 'create',
      type,
      name: type === 'file' ? 'untitled.txt' : 'untitled folder',
      busy: false,
      error: null,
    });
  }

  function startInlineRename(entry: FileEntry) {
    setSelectedEntry(entry);
    setContextMenu(null);
    setFileError(null);
    setInlineName({
      mode: 'rename',
      entry,
      name: entry.name,
      busy: false,
      error: null,
    });
  }

  function cancelInlineName() {
    if (inlineName?.busy) return;
    setInlineName(null);
  }

  async function handleInlineNameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!directory || !inlineName || inlineName.busy) return;

    const nextName = inlineName.name.trim();
    if (!nextName) {
      setInlineName({ ...inlineName, error: 'Name is required.' });
      return;
    }

    setInlineName({ ...inlineName, name: nextName, busy: true, error: null });
    try {
      const { entry } = inlineName.mode === 'create'
        ? await createFileEntry(directory.path, nextName, inlineName.type, inlineName.type === 'file' ? '' : undefined)
        : await renameFileEntry(inlineName.entry.path, nextName);

      const nextDirectory = await loadDirectory(directory.path, false);
      const matchingEntry = nextDirectory.entries.find((c) => c.path === entry.path) ?? entry;
      setInlineName(null);
      setSelectedEntry(matchingEntry);
    } catch (err) {
      setInlineName({
        ...inlineName,
        name: nextName,
        busy: false,
        error: toErrorMessage(err, 'Action failed'),
      });
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteDialog || !directory) return;

    const target = deleteDialog.entry;
    setDeleteDialog({ ...deleteDialog, busy: true, error: null });
    try {
      await deleteFileEntry(target.path, target.type === 'directory');
      await loadDirectory(directory.path, false);
      if (openFile && isSameOrChildPath(target.path, openFile.path)) closeOpenFile();
      if (selectedEntry && isSameOrChildPath(target.path, selectedEntry.path)) setSelectedEntry(null);
      if (infoEntry && isSameOrChildPath(target.path, infoEntry.path)) setInfoEntry(null);
      setDeleteDialog(null);
    } catch (err) {
      setDeleteDialog({
        ...deleteDialog,
        busy: false,
        error: toErrorMessage(err, 'Failed to delete file entry'),
      });
    }
  }

  function handlePageClick() {
    setContextMenu(null);
    setUploadMenuOpen(false);
  }

  function openEmptyContextMenu(event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    setUploadMenuOpen(false);
    setContextMenu({ kind: 'empty', ...contextMenuPosition(event) });
  }

  function openEntryContextMenu(event: ReactMouseEvent<HTMLElement>, entry: FileEntry) {
    event.preventDefault();
    event.stopPropagation();
    setUploadMenuOpen(false);
    setSelectedEntry(entry);
    setContextMenu({ kind: 'entry', entry, ...contextMenuPosition(event) });
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (isEditableTarget(event.target)) return;

    if (event.key === 'Enter' && selectedEntry) {
      event.preventDefault();
      void handleEntryOpen(selectedEntry);
      return;
    }

    if (event.key === 'Backspace' || (event.altKey && event.key === 'ArrowUp')) {
      event.preventDefault();
      void handleUp();
      return;
    }

    if (event.key === 'Escape') {
      if (contextMenu) setContextMenu(null);
      else if (inlineName) cancelInlineName();
    }
  }

  function updateInlineNameValue(name: string) {
    if (!inlineName) return;
    setInlineName({ ...inlineName, name, error: null });
  }

  const statusText = statusTextFor({
    count: directory?.entries.length ?? 0,
    selectedEntry,
    inlineName,
    loadingDirectory,
    loadingFile,
    uploading,
  });

  return (
    <div className="flex-1 overflow-hidden" onClick={handlePageClick}>
      <div className="flex h-full min-h-0 flex-col px-4 py-4">
        <input
          ref={fileUploadInputRef}
          type="file"
          multiple
          onChange={handleUploadInputChange}
          className="hidden"
        />
        <input
          ref={folderUploadInputRef}
          type="file"
          multiple
          onChange={handleUploadInputChange}
          className="hidden"
        />

        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-300 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          {!openFile && (
          <div className="grid min-h-[52px] grid-cols-[auto_minmax(140px,1fr)_auto] items-center gap-2 border-b border-zinc-300 bg-gradient-to-b from-zinc-50 to-zinc-200/80 px-3 py-2 dark:border-zinc-800 dark:from-zinc-900 dark:to-zinc-900/80">
            <div className="flex items-center gap-1">
              <ToolbarIconButton
                label="Back"
                disabled={backStack.length === 0 || loadingDirectory}
                onClick={() => void handleBack()}
              >
                <ChevronLeft size={16} />
              </ToolbarIconButton>
              <ToolbarIconButton
                label="Forward"
                disabled={forwardStack.length === 0 || loadingDirectory}
                onClick={() => void handleForward()}
              >
                <ChevronRight size={16} />
              </ToolbarIconButton>
              <ToolbarIconButton
                label="Up"
                disabled={!directory?.parentPath || loadingDirectory}
                onClick={() => void handleUp()}
              >
                <ChevronUp size={16} />
              </ToolbarIconButton>
            </div>

            <form
              onSubmit={handlePathSubmit}
              className="mx-auto flex h-8 w-full max-w-xl min-w-0 items-center gap-2 rounded-lg border border-zinc-300 bg-white/90 px-3 text-sm font-semibold text-zinc-800 shadow-[0_1px_1px_rgba(24,24,27,0.06)] transition-colors focus-within:border-zinc-400 focus-within:bg-white dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus-within:border-zinc-500"
              onClick={(event) => event.stopPropagation()}
            >
              <Folder size={16} className="shrink-0 text-zinc-500 dark:text-zinc-400" />
              <input
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    resetPathInput();
                    event.currentTarget.blur();
                  }
                }}
                disabled={!directory || loadingDirectory}
                aria-label="Directory path"
                spellCheck={false}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-xs font-semibold text-zinc-900 outline-none disabled:opacity-50 dark:text-zinc-100"
              />
              {loadingDirectory && <Loader2 size={14} className="shrink-0 animate-spin text-zinc-400" />}
            </form>

            <div className="flex items-center justify-end gap-1">
              <ToolbarIconButton
                label="New file"
                disabled={!directory}
                onClick={() => startInlineCreate('file')}
              >
                <FilePlus size={16} />
              </ToolbarIconButton>
              <ToolbarIconButton
                label="New folder"
                disabled={!directory}
                onClick={() => startInlineCreate('directory')}
              >
                <FolderPlus size={16} />
              </ToolbarIconButton>
              <span className="mx-1 h-6 w-px bg-zinc-300 dark:bg-zinc-700" />
              <div className="relative">
                <ToolbarIconButton
                  label={uploading ? 'Uploading' : 'Upload'}
                  disabled={!directory || uploading}
                  onClick={(event) => {
                    event.stopPropagation();
                    setContextMenu(null);
                    setUploadMenuOpen((open) => !open);
                  }}
                >
                  {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                </ToolbarIconButton>
                {uploadMenuOpen && (
                  <UploadMenu
                    onFiles={() => openUploadPicker('files')}
                    onFolder={() => openUploadPicker('folder')}
                  />
                )}
              </div>
              <ToolbarIconButton
                label={selectedEntry ? 'Download selected' : 'Download current folder'}
                disabled={!downloadTargetPath}
                onClick={() => handleDownload()}
              >
                <Download size={16} />
              </ToolbarIconButton>
              <ToolbarIconButton
                label="Get Info"
                disabled={!selectedEntry}
                onClick={() => selectedEntry && setInfoEntry(selectedEntry)}
              >
                <Info size={16} />
              </ToolbarIconButton>
            </div>
          </div>
          )}

          {(error || (!openFile && fileError)) && (
            <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              <AlertCircle size={15} className="shrink-0" />
              <span className="min-w-0 truncate">{error ?? fileError}</span>
            </div>
          )}

          {openFile ? (
            <EditorView
              file={openFile}
              content={content}
              error={fileError}
              dirty={isDirty}
              conflict={conflict}
              saving={saving}
              parentLabel={breadcrumbLabel}
              onContentChange={setContent}
              onBack={handleCloseEditor}
              onDiscard={() => void handleDiscard()}
              onSave={() => void handleSave(conflict)}
            />
          ) : (
            <FileListView
              directory={directory}
              selectedPath={selectedPath}
              inlineName={inlineName}
              inlineNameInputRef={inlineNameInputRef}
              loading={loadingDirectory}
              statusText={statusText}
              initialScrollTop={fileListScrollTopRef.current}
              onScrollTopChange={(scrollTop) => {
                fileListScrollTopRef.current = scrollTop;
              }}
              onSelect={selectEntry}
              onOpen={(entry) => void handleEntryOpen(entry)}
              onEntryContextMenu={openEntryContextMenu}
              onEmptyContextMenu={openEmptyContextMenu}
              onKeyDown={handleListKeyDown}
              onInlineNameChange={updateInlineNameValue}
              onInlineNameSubmit={handleInlineNameSubmit}
              onInlineNameCancel={cancelInlineName}
            />
          )}

          {contextMenu && (
            <FileBrowserContextMenu
              menu={contextMenu}
              onOpen={(entry) => void handleEntryOpen(entry)}
              onRename={startInlineRename}
              onDownload={(entry) => {
                setContextMenu(null);
                handleDownload(entry.path);
              }}
              onInfo={(entry) => {
                setContextMenu(null);
                setInfoEntry(entry);
              }}
              onDelete={(entry) => {
                setContextMenu(null);
                setDeleteDialog({ entry, busy: false, error: null });
              }}
              onCreateFile={() => startInlineCreate('file')}
              onCreateFolder={() => startInlineCreate('directory')}
              onUploadHere={() => openUploadPicker('files')}
            />
          )}
        </section>
      </div>

      {infoEntry && (
        <InfoModal
          entry={infoEntry}
          onClose={() => setInfoEntry(null)}
        />
      )}

      {deleteDialog && (
        <DeleteConfirmModal
          zIndex={60}
          title={`Delete ${deleteDialog.entry.type}`}
          body={
            deleteDialog.entry.type === 'directory'
              ? `Delete ${deleteDialog.entry.displayPath} and everything inside it?`
              : `Delete ${deleteDialog.entry.displayPath}?`
          }
          confirmLabel="Delete"
          isConfirming={deleteDialog.busy}
          error={deleteDialog.error}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteDialog(null)}
        />
      )}
    </div>
  );
}

function ToolbarIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-zinc-600 transition-colors hover:border-zinc-300 hover:bg-white/90 hover:text-zinc-950 disabled:opacity-40 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
    >
      {children}
    </button>
  );
}

function UploadMenu({
  onFiles,
  onFolder,
}: {
  onFiles: () => void;
  onFolder: () => void;
}) {
  return (
    <div
      className="absolute right-0 z-30 mt-2 w-36 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={onFiles}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <FileText size={14} />
        Files
      </button>
      <button
        type="button"
        onClick={onFolder}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <Folder size={14} />
        Folder
      </button>
    </div>
  );
}

function FileListView({
  directory,
  selectedPath,
  inlineName,
  inlineNameInputRef,
  loading,
  statusText,
  initialScrollTop,
  onScrollTopChange,
  onSelect,
  onOpen,
  onEntryContextMenu,
  onEmptyContextMenu,
  onKeyDown,
  onInlineNameChange,
  onInlineNameSubmit,
  onInlineNameCancel,
}: {
  directory: FileListResponse | null;
  selectedPath: string | null;
  inlineName: InlineNameOperation | null;
  inlineNameInputRef: RefObject<HTMLInputElement | null>;
  loading: boolean;
  statusText: string;
  initialScrollTop: number;
  onScrollTopChange: (scrollTop: number) => void;
  onSelect: (entry: FileEntry) => void;
  onOpen: (entry: FileEntry) => void;
  onEntryContextMenu: (event: ReactMouseEvent<HTMLElement>, entry: FileEntry) => void;
  onEmptyContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onInlineNameChange: (name: string) => void;
  onInlineNameSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onInlineNameCancel: () => void;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer) scrollContainer.scrollTop = initialScrollTop;
  }, [directory?.path, initialScrollTop]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-white dark:bg-zinc-950">
      <div className={`grid h-8 shrink-0 ${FILE_LIST_GRID} items-center gap-4 border-b border-zinc-200 bg-zinc-50 px-4 text-[11px] font-bold uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500`}>
        <span>Name</span>
        <span className="max-md:hidden">Modified</span>
        <span>Size</span>
        <span className="max-md:hidden">Kind</span>
      </div>

      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-auto outline-none"
        tabIndex={0}
        onScroll={(event) => onScrollTopChange(event.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        onContextMenu={onEmptyContextMenu}
      >
        <div className="min-h-full pb-8">
          {loading && !directory && (
            <div className="flex items-center gap-2 px-4 py-4 text-sm text-zinc-500 dark:text-zinc-400">
              <Loader2 size={14} className="animate-spin" />
              Loading files
            </div>
          )}

          {inlineName?.mode === 'create' && (
            <InlineEntryRow
              operation={inlineName}
              inputRef={inlineNameInputRef}
              onChange={onInlineNameChange}
              onSubmit={onInlineNameSubmit}
              onCancel={onInlineNameCancel}
            />
          )}

          {!loading && directory?.entries.length === 0 && !inlineName && (
            <div className="px-4 py-12 text-center text-sm text-zinc-400 dark:text-zinc-500">
              Empty directory.
            </div>
          )}

          {directory?.entries.map((entry) => {
            if (inlineName?.mode === 'rename' && inlineName.entry.path === entry.path) {
              return (
                <InlineEntryRow
                  key={entry.path}
                  operation={inlineName}
                  inputRef={inlineNameInputRef}
                  onChange={onInlineNameChange}
                  onSubmit={onInlineNameSubmit}
                  onCancel={onInlineNameCancel}
                />
              );
            }

            return (
              <FileEntryRow
                key={entry.path}
                entry={entry}
                selected={selectedPath === entry.path}
                onSelect={() => onSelect(entry)}
                onOpen={() => onOpen(entry)}
                onContextMenu={(event) => onEntryContextMenu(event, entry)}
              />
            );
          })}
        </div>
      </div>

      <div className="flex min-h-7 shrink-0 items-center justify-center border-t border-zinc-200 bg-zinc-50/95 px-3 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/95 dark:text-zinc-400">
        <span className="truncate">{statusText}</span>
      </div>
    </div>
  );
}

function FileEntryRow({
  entry,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  entry: FileEntry;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const rowClassName = selected
    ? 'bg-zinc-100 text-zinc-950 ring-1 ring-inset ring-zinc-300 dark:bg-zinc-800/70 dark:text-zinc-50 dark:ring-zinc-700'
    : entry.hidden
      ? 'text-zinc-500 hover:bg-zinc-50 dark:text-zinc-500 dark:hover:bg-zinc-900'
      : 'text-zinc-900 hover:bg-zinc-50 dark:text-zinc-100 dark:hover:bg-zinc-900';

  const mutedClassName = selected ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-500 dark:text-zinc-500';

  return (
    <div
      role="button"
      tabIndex={-1}
      title={entry.displayPath}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      className={`grid min-h-[34px] cursor-default ${FILE_LIST_GRID} items-center gap-4 border-b border-zinc-100 px-4 text-sm transition-colors dark:border-zinc-900 ${rowClassName}`}
    >
      <span className="flex min-w-0 items-center gap-2 font-medium">
        <span className={selected ? 'text-zinc-700 dark:text-zinc-200' : 'text-zinc-500 dark:text-zinc-400'}>
          <EntryIcon entry={entry} />
        </span>
        <span className="min-w-0 truncate">{entry.name}</span>
      </span>
      <span className={`truncate text-xs max-md:hidden ${mutedClassName}`}>
        {formatDate(entry.modifiedAt)}
      </span>
      <span className={`truncate text-xs ${mutedClassName}`}>
        {entry.type === 'directory' ? '-' : formatBytes(entry.size)}
      </span>
      <span className={`truncate text-xs max-md:hidden ${mutedClassName}`}>
        {kindLabel(entry)}
      </span>
    </div>
  );
}

function InlineEntryRow({
  operation,
  inputRef,
  onChange,
  onSubmit,
  onCancel,
}: {
  operation: InlineNameOperation;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (name: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const entry = operation.mode === 'rename' ? operation.entry : null;
  const type = operation.mode === 'create' ? operation.type : entry?.type ?? 'file';
  const size = operation.mode === 'create'
    ? operation.type === 'file' ? '0 B' : '-'
    : entry?.type === 'directory' ? '-' : formatBytes(entry?.size ?? null);
  const modified = operation.mode === 'create' ? 'Now' : formatDate(entry?.modifiedAt);
  const kind = operation.mode === 'create'
    ? operation.type === 'file' ? 'New file' : 'New folder'
    : entry ? kindLabel(entry) : 'File';

  return (
    <form
      onSubmit={onSubmit}
      className={`grid min-h-[42px] ${FILE_LIST_GRID} items-center gap-4 border-b border-zinc-100 bg-zinc-100 px-4 py-1 text-sm text-zinc-950 ring-1 ring-inset ring-zinc-300 dark:border-zinc-900 dark:bg-zinc-800/70 dark:text-zinc-50 dark:ring-zinc-700`}
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className="mt-1 text-zinc-700 dark:text-zinc-200">
          {type === 'directory' ? <Folder size={17} /> : <FileText size={17} />}
        </span>
        <span className="min-w-0 flex-1">
          <input
            ref={inputRef}
            value={operation.name}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
              }
            }}
            disabled={operation.busy}
            aria-label={operation.mode === 'create' ? 'New entry name' : 'New name'}
            className="h-7 w-full max-w-sm rounded-md border border-zinc-300 bg-white px-2 text-base text-zinc-950 outline-none focus:border-zinc-500 disabled:opacity-70 dark:border-zinc-500"
          />
          {operation.error && (
            <span className="mt-1 block truncate text-xs text-red-600 dark:text-red-300">
              {operation.error}
            </span>
          )}
        </span>
        {operation.busy && <Loader2 size={14} className="mt-1 shrink-0 animate-spin" />}
      </span>
      <span className="truncate text-xs text-inherit max-md:hidden">{modified}</span>
      <span className="truncate text-xs text-inherit">{size}</span>
      <span className="truncate text-xs text-inherit max-md:hidden">{kind}</span>
    </form>
  );
}

function EditorView({
  file,
  content,
  error,
  dirty,
  conflict,
  saving,
  parentLabel,
  onContentChange,
  onBack,
  onDiscard,
  onSave,
}: {
  file: FileReadResponse;
  content: string;
  error: string | null;
  dirty: boolean;
  conflict: boolean;
  saving: boolean;
  parentLabel: string;
  onContentChange: (content: string) => void;
  onBack: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const saveRef = useRef(onSave);
  const canSaveRef = useRef(dirty && !saving);
  saveRef.current = onSave;
  canSaveRef.current = dirty && !saving;

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (canSaveRef.current) saveRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0">
          <nav className="flex items-center gap-1 text-sm">
            <button
              type="button"
              onClick={onBack}
              aria-label={`Back to ${parentLabel}`}
              title={`Back to ${parentLabel}`}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <ArrowLeft size={14} />
              {parentLabel}
            </button>
            <span className="text-zinc-400 dark:text-zinc-600">/</span>
            {dirty && !conflict && (
              <span className="text-amber-600 dark:text-amber-400">•</span>
            )}
            <span
              title={file.displayPath}
              className="min-w-0 truncate px-1 font-semibold text-zinc-900 dark:text-zinc-100"
            >
              {file.name}
            </span>
          </nav>
          <p className="ml-2 mt-1 truncate text-xs text-zinc-500 dark:text-zinc-500">
            {formatBytes(file.size)} · {formatDate(file.modifiedAt)} · {file.encoding}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {conflict ? (
            <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              Changed on disk
            </span>
          ) : dirty && !saving ? (
            <>
              <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                Unsaved
              </span>
              <button
                type="button"
                onClick={onDiscard}
                title="Discard changes"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                <RotateCcw size={14} />
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saving}
            title="Save (⌘S)"
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {conflict ? 'Overwrite' : 'Save'}
          </button>
          <span className="mx-1 h-6 w-px bg-zinc-200 dark:bg-zinc-700" />
          <button
            type="button"
            onClick={onBack}
            aria-label="Close file"
            title="Close file"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <X size={14} />
            Close
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <AlertCircle size={15} className="shrink-0" />
          <span className="min-w-0 truncate">{error}</span>
        </div>
      )}

      {isCsvFile(file.name) ? (
        <CsvEditor content={content} onContentChange={onContentChange} />
      ) : (
        <textarea
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none border-0 bg-white p-4 font-mono text-sm leading-relaxed text-zinc-900 outline-none dark:bg-zinc-950 dark:text-zinc-100"
        />
      )}
    </div>
  );
}

function FileBrowserContextMenu({
  menu,
  onOpen,
  onRename,
  onDownload,
  onInfo,
  onDelete,
  onCreateFile,
  onCreateFolder,
  onUploadHere,
}: {
  menu: ContextMenu;
  onOpen: (entry: FileEntry) => void;
  onRename: (entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
  onInfo: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  onUploadHere: () => void;
}) {
  return (
    <div
      className="fixed z-40 w-56 overflow-hidden rounded-xl border border-zinc-300 bg-white/95 p-1.5 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
    >
      {menu.kind === 'entry' ? (
        <>
          <ContextMenuItem icon={<FileText size={15} />} label="Open" onClick={() => onOpen(menu.entry)} />
          <ContextMenuItem icon={<Pencil size={15} />} label="Rename" onClick={() => onRename(menu.entry)} />
          <ContextMenuItem icon={<Download size={15} />} label="Download" onClick={() => onDownload(menu.entry)} />
          <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
          <ContextMenuItem icon={<Info size={15} />} label="Get Info" onClick={() => onInfo(menu.entry)} />
          <ContextMenuItem
            icon={<Trash2 size={15} />}
            label="Delete"
            danger
            onClick={() => onDelete(menu.entry)}
          />
        </>
      ) : (
        <>
          <ContextMenuItem icon={<FilePlus size={15} />} label="New File" onClick={onCreateFile} />
          <ContextMenuItem icon={<FolderPlus size={15} />} label="New Folder" onClick={onCreateFolder} />
          <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
          <ContextMenuItem icon={<Upload size={15} />} label="Upload Here" onClick={onUploadHere} />
        </>
      )}
    </div>
  );
}

function ContextMenuItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors ${
        danger
          ? 'text-red-700 hover:bg-red-600 hover:text-white dark:text-red-400'
          : 'text-zinc-800 hover:bg-zinc-900 hover:text-white dark:text-zinc-200 dark:hover:bg-zinc-100 dark:hover:text-zinc-950'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function InfoModal({
  entry,
  onClose,
}: {
  entry: FileEntry;
  onClose: () => void;
}) {
  const fields = [
    ['Name', entry.name],
    ['Kind', kindLabel(entry)],
    ['Size', entry.type === 'directory' ? '-' : formatBytes(entry.size)],
    ['Modified', formatDate(entry.modifiedAt)],
    ['Path', entry.displayPath],
    ['Hidden', entry.hidden ? 'Yes' : 'No'],
    ['Readable', entry.readable ? 'Yes' : 'No'],
    ['Writable', entry.writable ? 'Yes' : 'No'],
  ];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <section className="relative mx-4 w-full max-w-md rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">Get Info</h2>
            <p className="mt-0.5 truncate font-mono text-xs text-zinc-500 dark:text-zinc-500">{entry.displayPath}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <X size={15} />
          </button>
        </div>
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-3 px-5 py-4 text-sm">
          {fields.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-zinc-500 dark:text-zinc-500">{label}</dt>
              <dd className="min-w-0 truncate text-zinc-900 dark:text-zinc-100" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  if (entry.type === 'directory') return <Folder size={17} />;
  if (entry.type === 'file') return <FileText size={17} />;
  return <File size={17} />;
}

function entryFromReadResponse(file: FileReadResponse): FileEntry {
  return {
    name: file.name,
    path: file.path,
    displayPath: file.displayPath,
    type: 'file',
    hidden: file.name.startsWith('.'),
    size: file.size,
    modifiedAt: file.modifiedAt,
    readable: true,
    writable: true,
  };
}

function contextMenuPosition(event: ReactMouseEvent<HTMLElement>) {
  const menuWidth = 224;
  const menuHeight = 220;
  return {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
  };
}

function kindLabel(entry: FileEntry): string {
  if (entry.type === 'directory') return entry.hidden ? 'Hidden folder' : 'Folder';
  if (entry.type === 'symlink') return entry.hidden ? 'Hidden symlink' : 'Symlink';
  if (entry.type === 'other') return entry.hidden ? 'Hidden item' : 'Item';

  const extension = fileExtension(entry.name);
  const label = extensionLabel(extension);
  return entry.hidden ? `Hidden ${label.toLowerCase()}` : label;
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

function extensionLabel(extension: string): string {
  if (extension === 'csv') return 'CSV';
  if (extension === 'md' || extension === 'markdown') return 'Markdown';
  if (extension === 'txt' || extension === 'log') return 'Text';
  if (extension === 'json') return 'JSON';
  if (extension === 'yaml' || extension === 'yml') return 'YAML';
  if (extension === 'ts' || extension === 'tsx') return 'TypeScript';
  if (extension === 'js' || extension === 'jsx') return 'JavaScript';
  if (extension === 'py') return 'Python';
  if (extension === '') return 'File';
  return `${extension.toUpperCase()} file`;
}

function statusTextFor({
  count,
  selectedEntry,
  inlineName,
  loadingDirectory,
  loadingFile,
  uploading,
}: {
  count: number;
  selectedEntry: FileEntry | null;
  inlineName: InlineNameOperation | null;
  loadingDirectory: boolean;
  loadingFile: boolean;
  uploading: boolean;
}): string {
  if (uploading) return 'Uploading';
  if (loadingFile) return 'Opening file';
  if (loadingDirectory && count === 0) return 'Loading files';
  if (inlineName?.mode === 'create') {
    return `${count} ${pluralize(count, 'item')}, editing new ${inlineName.type === 'directory' ? 'folder' : 'file'} name`;
  }
  if (inlineName?.mode === 'rename') return `${count} ${pluralize(count, 'item')}, renaming`;
  if (selectedEntry) {
    const size = selectedEntry.type === 'directory' ? null : selectedEntry.size;
    return `${count} ${pluralize(count, 'item')}, 1 selected${size == null ? '' : `, ${formatBytes(size)}`}`;
  }
  return `${count} ${pluralize(count, 'item')}`;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function isCsvFile(name: string): boolean {
  return fileExtension(name) === 'csv';
}

function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  if (parentPath === childPath) return true;
  const prefix = parentPath.endsWith('/') ? parentPath : `${parentPath}/`;
  return childPath.startsWith(prefix);
}

function parentBreadcrumbLabel(directory: FileListResponse | null): string {
  if (!directory) return 'Files';
  if (directory.path === WORKSPACE_ROOT) return 'Workspace';
  const segments = directory.path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? 'Workspace';
}

