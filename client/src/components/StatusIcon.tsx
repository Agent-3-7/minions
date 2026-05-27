import type { TaskStatus } from '@shared/types';

export function StatusIcon({ status }: { status: TaskStatus }) {
  switch (status) {
    case 'todo':
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="5.5" stroke="#0ea5e9" strokeWidth="1.5" />
        </svg>
      );
    case 'in_progress':
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="5.5" stroke="#f59e0b" strokeWidth="1.5" />
          <path d="M7 1.5a5.5 5.5 0 0 1 0 11V1.5z" fill="#f59e0b" />
        </svg>
      );
    case 'in_review':
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="5.5" stroke="#a855f7" strokeWidth="1.5" />
          <path d="M7 1.5a5.5 5.5 0 0 1 0 11V1.5z" fill="#a855f7" />
        </svg>
      );
    case 'done':
      return (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="6.5" fill="#22c55e" />
          <path d="M4.5 7l2 2 3.5-3.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}
