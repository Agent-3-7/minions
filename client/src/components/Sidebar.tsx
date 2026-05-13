import { useEffect } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { SquarePen, Columns3, Settings, PanelLeftClose, PanelLeft, CalendarClock, Sparkles, Folder } from 'lucide-react';
import { useStore } from '../lib/store';
import { isEditableTarget } from '../lib/keyboard';

const isMac = /Mac/.test(navigator.userAgent);

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

  useEffect(() => {
    let chordKey: string | null = null;
    let chordTimeout: ReturnType<typeof setTimeout> | null = null;

    function handleKeyDown(e: KeyboardEvent) {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        navigate('/tasks/new');
        return;
      }

      if (isEditableTarget(e) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

      const key = e.key.toLowerCase();

      if (chordKey === 'g') {
        chordKey = null;
        if (chordTimeout) clearTimeout(chordTimeout);
        const routes: Record<string, string> = { t: '/', f: '/files' };
        if (routes[key]) {
          e.preventDefault();
          navigate(routes[key]);
        }
        return;
      }

      if (key === 'g') {
        chordKey = 'g';
        if (chordTimeout) clearTimeout(chordTimeout);
        chordTimeout = setTimeout(() => { chordKey = null; }, 500);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (chordTimeout) clearTimeout(chordTimeout);
    };
  }, [navigate]);

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/' || (location.pathname.startsWith('/tasks/') && location.pathname !== '/tasks/new');
    return location.pathname === path;
  };

  return (
    <aside
      className={`shrink-0 bg-sidebar dark:bg-zinc-950 flex flex-col transition-[width] duration-200 ease-in-out ${
        collapsed ? 'w-16' : 'w-56'
      }`}
    >
      <div className="flex items-center justify-center py-4 px-2">
        {collapsed ? (
          <button
            onClick={toggleSidebar}
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors p-1.5 rounded-lg hover:bg-surface dark:hover:bg-zinc-800"
            title="Expand sidebar"
          >
            <PanelLeft size={20} />
          </button>
        ) : (
          <div className="flex items-center justify-between w-full px-2">
            <button onClick={() => navigate('/')} className="shrink-0" title="Home">
              <img src="/logo.png" alt="Logo" className="w-9 h-9" />
            </button>
            <button
              onClick={toggleSidebar}
              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors p-1.5 rounded-lg hover:bg-surface dark:hover:bg-zinc-800"
              title="Collapse sidebar"
            >
              <PanelLeftClose size={18} />
            </button>
          </div>
        )}
      </div>

      <nav className={`space-y-1 ${collapsed ? 'px-2' : 'px-3'}`}>
        <SidebarLink
          icon={<SquarePen size={18} />}
          label="New Task"
          to="/tasks/new"
          active={isActive('/tasks/new')}
          collapsed={collapsed}
          shortcut={isMac ? '⇧⌘O' : 'Ctrl+⇧+O'}
        />
        <SidebarLink
          icon={<Columns3 size={18} />}
          label="Tasks"
          to="/"
          active={isActive('/')}
          collapsed={collapsed}
          shortcut={['G', 'T']}
        />
        <SidebarLink
          icon={<Folder size={18} />}
          label="Files"
          to="/files"
          active={isActive('/files')}
          collapsed={collapsed}
          shortcut={['G', 'F']}
        />
        <SidebarLink
          icon={<CalendarClock size={18} />}
          label="Schedules"
          to="/cron"
          active={isActive('/cron')}
          collapsed={collapsed}
        />
        <SidebarLink
          icon={<Sparkles size={18} />}
          label="Skills"
          to="/skills"
          active={isActive('/skills')}
          collapsed={collapsed}
        />
        <SidebarLink
          icon={<Settings size={18} />}
          label="Settings"
          to="/settings"
          active={isActive('/settings')}
          collapsed={collapsed}
        />
      </nav>

    </aside>
  );
}

function SidebarLink({
  icon,
  label,
  to,
  active,
  collapsed,
  shortcut,
}: {
  icon: React.ReactNode;
  label: string;
  to: string;
  active: boolean;
  collapsed: boolean;
  shortcut?: string | string[];
}) {
  return (
    <Link
      to={to}
      title={collapsed ? (shortcut ? `${label} (${Array.isArray(shortcut) ? shortcut.join(' then ') : shortcut})` : label) : undefined}
      className={`group w-full flex items-center ${collapsed ? 'justify-center' : 'gap-3'} px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
        active
          ? 'bg-surface dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm'
          : 'text-zinc-700 dark:text-zinc-300 hover:bg-surface dark:hover:bg-zinc-800'
      }`}
    >
      <span className={active ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500 dark:text-zinc-400'}>
        {icon}
      </span>
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && shortcut && (
        Array.isArray(shortcut) ? (
          <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Kbd>{shortcut[0]}</Kbd>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">then</span>
            <Kbd>{shortcut[1]}</Kbd>
          </span>
        ) : (
          <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity tracking-widest">
            {shortcut}
          </span>
        )
      )}
    </Link>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="text-[11px] font-medium leading-none px-1.5 py-0.5 rounded border border-zinc-300/60 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">
      {children}
    </kbd>
  );
}
