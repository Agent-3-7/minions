import { useEffect, useRef } from 'react';

/**
 * Hook that triggers a callback when the page becomes visible after being hidden.
 * Useful for refreshing stale data after the user returns to the app from the background.
 * Also triggers on first mount so apps started from background get an initial refresh.
 */
export function useVisibilityRefresh(callback: () => void) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    let wasHidden = document.hidden;

    function handleVisibilityChange() {
      if (document.hidden) {
        wasHidden = true;
      } else if (wasHidden) {
        wasHidden = false;
        callbackRef.current();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);
}
