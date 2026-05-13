export function isEditableTarget(e: Event): boolean {
  const el = e.target as HTMLElement;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export function handleChatKeyDown(e: React.KeyboardEvent, onSubmit: () => void) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSubmit();
  }
  if (e.key === 'Escape') {
    e.stopPropagation();
    (e.target as HTMLElement).blur();
  }
}
