import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_IDLE_AFTER_MS } from "../lib/activity";

export interface AgentActivity {
  /** Record that a session just produced output. Cheap enough to call per chunk. */
  markOutput: (sessionId: string) => void;
  /** True while the session produced output within the idle window. */
  isBusy: (sessionId: string) => boolean;
}

type BusyMap = Readonly<Record<string, boolean>>;

/**
 * Tracks per-session agent activity from PTY output. Re-renders only when a
 * session flips between busy and idle, never once per output chunk.
 */
export function useAgentActivity(
  idleAfterMs: number = AGENT_IDLE_AFTER_MS,
): AgentActivity {
  const [busy, setBusy] = useState<BusyMap>({});
  const busyRef = useRef<BusyMap>(busy);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const setSessionBusy = useCallback((sessionId: string, value: boolean) => {
    const next = { ...busyRef.current, [sessionId]: value };
    busyRef.current = next;
    setBusy(next);
  }, []);

  const markOutput = useCallback(
    (sessionId: string) => {
      const timers = timersRef.current;
      const pending = timers.get(sessionId);
      if (pending !== undefined) clearTimeout(pending);

      timers.set(
        sessionId,
        setTimeout(() => {
          timers.delete(sessionId);
          setSessionBusy(sessionId, false);
        }, idleAfterMs),
      );

      if (!busyRef.current[sessionId]) setSessionBusy(sessionId, true);
    },
    [idleAfterMs, setSessionBusy],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const isBusy = useCallback(
    (sessionId: string) => busy[sessionId] === true,
    [busy],
  );

  return { markOutput, isBusy };
}
