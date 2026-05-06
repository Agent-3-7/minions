import { useEffect } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { SquarePen, Columns3, Settings, PanelLeftClose, PanelLeft, CalendarClock, Sparkles } from 'lucide-react';
import { useStore } from '../lib/store';

const isMac = /Mac/.test(navigator.userAgent);

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        navigate('/tasks/new');
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/' || location.pathname.startsWith('/tasks/');
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
          active={false}
          collapsed={collapsed}
          shortcut={isMac ? '⇧⌘O' : 'Ctrl+⇧+O'}
        />
        <SidebarLink
          icon={<Columns3 size={18} />}
          label="Tasks"
          to="/"
          active={isActive('/')}
          collapsed={collapsed}
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
  shortcut?: string;
}) {
  return (
    <Link
      to={to}
      title={collapsed ? (shortcut ? `${label} (${shortcut})` : label) : undefined}
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
        <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity tracking-widest">
          {shortcut}
        </span>
      )}
    </Link>
  );
}
