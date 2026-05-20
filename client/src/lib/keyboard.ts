import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ChatRunMode } from '@shared/types';

export const GOAL_MODE_SHORTCUT_LABEL = 'Shift+Tab';

export function toggleRunMode(current: ChatRunMode): ChatRunMode {
  return current === 'goal' ? 'task' : 'goal';
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

interface ChatKeyDownOptions {
  onGoalToggle?: () => void;
  goalToggleDisabled?: boolean;
}

export function handleChatKeyDown(
  e: ReactKeyboardEvent,
  onSubmit: () => void,
  options: ChatKeyDownOptions = {},
) {
  if (
    e.key === 'Tab' &&
    e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    options.onGoalToggle &&
    !options.goalToggleDisabled
  ) {
    e.preventDefault();
    options.onGoalToggle();
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSubmit();
  }
  if (e.key === 'Escape') {
    e.stopPropagation();
    (e.target as HTMLElement).blur();
  }
}
