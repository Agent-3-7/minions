# iOS Safari Smoke Test — AgentControl

## Prerequisites
- iPhone or iPad with iOS 17+
- Safari on the iOS device
- AgentControl running via Cloudflare Tunnel or local dev reachable from the device
- Another client (desktop) to create/move tasks while the iOS device is in background

## Test Checklist

### 1. Viewport & Safe Area
- [ ] Open Safari, navigate to the AgentControl URL (e.g. `https://ms.selly.dev`).
- [ ] Check: no horizontal overflow, board is scrollable only vertically.
- [ ] Rotate to landscape: the board still renders columns with a min-width, is horizontally scrollable, and no content overlaps the notch or curved corners.
- [ ] Dark mode switch in iOS Settings: board respects `prefers-color-scheme`.

### 2. Input Zoom Prevention
- [ ] Tap "New Task" textarea. Check: iOS **does NOT auto-zoom** because the font size is `text-base` (>=16px).
- [ ] Tap Task Chat input. Auto-zoom should not occur.
- [ ] Tap Scheduled Task editor textarea (prompt field). No zoom.
- [ ] Tap any text input in the Model Picker search, Skills search, File Browser rename/create.
- [ ] Inputs must have visible text at 100% zoom on iPhone.

### 3. Touch & Scroll Ergonomics
- [ ] Drag a task card from one column to another: drag starts after 5px motion (PointerSensor distance constraint).
- [ ] Long-press on a task card to open context menu.
- [ ] Horizontal board scroll on iPhone: one-finger scroll on column area must scroll the board, not a column. Touch-action is set to `manipulation` in `globals.css`.

### 4. SSE + Polling Recovery
- [ ] Open the board on iOS. Background the Safari tab (switch to another app/home screen).
- [ ] From the desktop client: create a new task and move a task from `in_progress` to `done`.
- [ ] Return to Safari on iOS after **15 seconds**.
- [ ] Check ONE: the board **automatically refetches** `/api/tasks` on `visibilitychange→visible`.
- [ ] Check TWO: if the SSE reconnect fails (e.g. on Cloudflare Access redirect), a **30s polling fallback** should still refresh the board.
- [ ] Delete a task from desktop. Switch back to iOS. Board should reflect the deletion within 30s or immediately on foreground.

### 5. Cloudflare Access Redirect Tolerance
- [ ] If Cloudflare Access times out, Safari may redirect to a login page that destroys the EventSource.
- [ ] After re-authenticating and returning to the board, the page should refetch tasks automatically (via page load or visibilitychange refresh).
- [ ] The board should NOT stay stale indefinitely waiting for an SSE that will never reconnect.

### 6. Build Verification
- [ ] `cd /Users/renatowasescha/GIT/jarvis-mission-control && npm run build` exits with code 0.
- [ ] No new TypeScript errors introduced by the iOS changes.

## Expected Results
1. iOS Safari does **not** auto-zoom on any input.
2. Safe-area insets (top notch / bottom home indicator) do **not** clip UI.
3. When returning from background, the board refreshes automatically within 1 second (or within 30s via polling if SSE stalled).
4. EventSource that got closed due to iOS backgrounding or Access redirect **does not** leave the board permanently outdated.

## Notes
- `viewport-fit=cover` in `index.html` ensures the CSS `env(safe-area-inset-*)` values are non-zero on devices with notches.
- `-webkit-tap-highlight-color: transparent` removes the grey tap flash on touch.
- `-webkit-text-size-adjust: 100%` disables iOS font auto-scaling.
