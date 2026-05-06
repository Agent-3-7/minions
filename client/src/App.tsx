import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Board } from './components/Board';
import { NewTaskPage } from './components/NewTaskPage';
import { TaskDetailPage } from './components/TaskDetailPage';
import { SettingsPage } from './components/SettingsPage';
import { CronPage } from './components/CronPage';
import { SkillsPage } from './components/SkillsPage';
import { useTasks } from './hooks/useTasks';
import { useTheme } from './hooks/useTheme';

function AppShell() {
  useTasks();
  useTheme();

  return (
    <div className="h-screen flex overflow-hidden bg-sidebar dark:bg-zinc-950">
      <Sidebar />
      <main className="m-2 ml-0 flex-1 flex flex-col min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-surface shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <Header />
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/tasks/new" element={<NewTaskPage />} />
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="/cron" element={<CronPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
