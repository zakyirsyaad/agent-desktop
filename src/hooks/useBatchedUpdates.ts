import { useCallback, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import type { ChatMessage } from "../types";
import { useLatest } from "./useLatest";

export type MessageUpdater = (prev: ChatMessage[]) => ChatMessage[];

interface QueuedUpdate {
  sessionId: string;
  updater: MessageUpdater;
}

export interface BatchedUpdates {
  /** Queues a change; every change queued in one frame applies in order, in one updateMessages call per session. */
  update: (sessionId: string, updater: MessageUpdater) => void;
  /** Applies everything queued now, for a read that must see it first. */
  flush: () => void;
  /** Drops a session's queued changes, e.g. once its transcript is deleted. */
  forget: (sessionId: string) => void;
}

/**
 * Coalesces transcript changes that arrive many times a second: an agent
 * streams a chunk per event, and React would otherwise render for each one.
 * The queue is per session and ordered, so a permission card or a turn end
 * still lands after the chunks that came before it.
 */
export function useBatchedUpdates(
  updateMessages: (sessionId: string, updater: MessageUpdater) => void,
): BatchedUpdates {
  const updateMessagesRef = useLatest(updateMessages);
  const pendingRef = useRef<QueuedUpdate[]>([]);
  const frameRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

  const flush = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];
    const bySession = new Map<string, MessageUpdater[]>();
    for (const { sessionId, updater } of pending) {
      const updaters = bySession.get(sessionId);
      if (updaters) updaters.push(updater);
      else bySession.set(sessionId, [updater]);
    }
    for (const [sessionId, updaters] of bySession) {
      // Synchronous, so a caller that flushes before reading the transcript
      // (a turn end handing a message back) sees the applied result.
      flushSync(() => {
        updateMessagesRef.current(sessionId, (prev) =>
          updaters.reduce((messages, updater) => updater(messages), prev),
        );
      });
    }
  }, [updateMessagesRef]);

  const update = useCallback(
    (sessionId: string, updater: MessageUpdater) => {
      pendingRef.current.push({ sessionId, updater });
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          flush();
        });
      }
    },
    [flush],
  );

  const forget = useCallback((sessionId: string) => {
    pendingRef.current = pendingRef.current.filter((queued) => queued.sessionId !== sessionId);
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return { update, flush, forget };
}
