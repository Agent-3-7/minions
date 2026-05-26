import { createContext, useContext, useLayoutEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Link, useMatch, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useStore } from '../lib/store';
import { RenameTitle } from './RenameTitle';

export type PageHeaderCrumb = {
  label: string;
  to?: string;
};

export type PageHeaderConfig = {
  crumbs: PageHeaderCrumb[];
  actions?: ReactNode;
};

type PageHeaderEntry = {
  owner: symbol;
  config: PageHeaderConfig;
};

const PageHeaderEntryContext = createContext<PageHeaderEntry | null>(null);
const PageHeaderDispatchContext = createContext<Dispatch<SetStateAction<PageHeaderEntry | null>> | null>(null);

export function HeaderProvider({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<PageHeaderEntry | null>(null);
  return (
    <PageHeaderDispatchContext.Provider value={setEntry}>
      <PageHeaderEntryContext.Provider value={entry}>
        {children}
      </PageHeaderEntryContext.Provider>
    </PageHeaderDispatchContext.Provider>
  );
}

export function usePageHeader(config: PageHeaderConfig) {
  const setEntry = useContext(PageHeaderDispatchContext);
  const ownerRef = useRef<symbol>(Symbol('page-header'));

  useLayoutEffect(() => {
    if (!setEntry) return undefined;
    const owner = ownerRef.current;
    setEntry({ owner, config });
    return () => {
      setEntry((current) => (current?.owner === owner ? null : current));
    };
  }, [config, setEntry]);
}

function HeaderCrumbs({ crumbs }: { crumbs: PageHeaderCrumb[] }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
      {crumbs.map((crumb, index) => (
        <div key={`${crumb.label}:${index}`} className="flex min-w-0 items-center gap-2">
          {index > 0 && <ChevronRight size={14} className="shrink-0 text-zinc-300 dark:text-zinc-700" />}
          {crumb.to ? (
            <Link to={crumb.to} className="truncate text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
              {crumb.label}
            </Link>
          ) : (
            <span className="truncate text-zinc-900 dark:text-zinc-100">{crumb.label}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function Header() {
  const location = useLocation();
  const pageHeader = useContext(PageHeaderEntryContext)?.config ?? null;
  const match = useMatch('/tasks/:taskId');
  const taskId = match?.params.taskId;
  const task = useStore((s) => taskId ? s.tasks.find((t) => t.id === taskId) : null);

  const isSettings = location.pathname === '/settings';
  const isNewTask = location.pathname === '/tasks/new';
  const isScheduledTasks = location.pathname.startsWith('/scheduled-tasks') || location.pathname === '/cron';
  const isSkills = location.pathname === '/skills' || location.pathname.startsWith('/skills/');
  const isFiles = location.pathname === '/files';
  const isTerminal = location.pathname === '/terminal';

  let title = 'Tasks';
  let showParent = false;
  let truncate = false;

  if (isSettings) {
    title = 'Settings';
  } else if (isScheduledTasks) {
    title = 'Recurring';
  } else if (isSkills) {
    title = 'Skills';
  } else if (isFiles) {
    title = 'Files';
  } else if (isTerminal) {
    title = 'Terminal';
  } else if (isNewTask) {
    title = 'New Task';
    showParent = true;
  } else if (task) {
    title = 'Task';
    showParent = true;
  }

  if (pageHeader) {
    return (
      <header className="flex min-h-[49px] items-center justify-between gap-3 border-b border-zinc-200 bg-surface px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-950 sm:min-h-[55px] sm:gap-4 sm:px-6 sm:py-3">
        <HeaderCrumbs crumbs={pageHeader.crumbs} />
        {pageHeader.actions && <div className="flex shrink-0 items-center gap-2">{pageHeader.actions}</div>}
      </header>
    );
  }

  return (
    <header className="flex items-center border-b border-zinc-200 bg-surface px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-950 sm:px-6 sm:py-3">
      <div className="flex items-center gap-2 min-w-0">
        {showParent && (
          <>
            <Link to="/" className="text-sm font-medium text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors shrink-0">
              Tasks
            </Link>
            <ChevronRight size={14} className="text-zinc-300 dark:text-zinc-600 shrink-0" />
          </>
        )}
        <RenameTitle
          value={title}
          identity={task?.id ?? location.pathname}
          className={`inline-block min-w-0 text-sm font-medium text-zinc-900 dark:text-zinc-100${truncate ? ' max-w-full truncate' : ''}`}
        />
      </div>
    </header>
  );
}
