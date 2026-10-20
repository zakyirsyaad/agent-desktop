import { useEffect, useRef, useState } from 'react';

/**
 * Counts the times the active agent stopped working (a turn ended), so what it may have changed is read again.
 */
export function useTurnsEnded(isActiveBusy: boolean): number {
  const [turnsEnded, setTurnsEnded] = useState(0);
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (wasBusyRef.current && !isActiveBusy) setTurnsEnded((n) => n + 1);
    wasBusyRef.current = isActiveBusy;
  }, [isActiveBusy]);
  return turnsEnded;
}
