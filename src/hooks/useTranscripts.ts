import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { deleteTranscript, loadTranscript, saveTranscript } from '../lib/persistence';
import { useLatest } from './useLatest';

type Transcripts = Record<string, ChatMessage[]>;

/**
 * A streaming agent changes its transcript many times a second; the whole
 * transcript is written at most this often, and still during a long stream.
 */
const TRANSCRIPT_SAVE_INTERVAL_MS = 1000;

export interface TranscriptsHandle {
  transcripts: Transcripts;
  ensureLoaded: (sessionId: string) => void;
  updateMessages: (sessionId: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  removeTranscript: (sessionId: string) => void;
}

function omitKey(record: Transcripts, key: string): Transcripts {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/**
 * Chat messages per session: loaded lazily from disk the first time a session
 * is shown, and saved per session at most once per interval while it changes.
 */
export function useTranscripts(onError: (message: string) => void): TranscriptsHandle {
  const [transcripts, setTranscripts] = useState<Transcripts>({});
  const transcriptsRef = useLatest(transcripts);
  const onErrorRef = useLatest(onError);
  const requestedRef = useRef(new Set<string>());
  // Sessions whose file is being read: saving now would overwrite their history.
  const loadingRef = useRef(new Set<string>());
  // Sessions whose file could not be read: it may still be recoverable, so
  // this run never writes over it.
  const unreadableRef = useRef(new Set<string>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, []);

  /** Writes the transcript now, unless its file is still loading (retry later) or unreadable. */
  const save = useCallback(
    (sessionId: string) => {
      if (loadingRef.current.has(sessionId)) {
        scheduleSaveRef.current(sessionId);
        return;
      }
      if (unreadableRef.current.has(sessionId)) return;
      saveTranscript(sessionId, transcriptsRef.current[sessionId] ?? []).catch((error) => {
        onErrorRef.current(`Failed to save the conversation: ${String(error)}`);
      });
    },
    // scheduleSaveRef is a ref declared below (save and scheduleSave call each other): stable, and not readable here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transcriptsRef, onErrorRef],
  );

  /** A throttle, not a debounce: a save already due writes the latest messages, so it is not pushed back. */
  const scheduleSave = useCallback(
    (sessionId: string) => {
      const timers = timersRef.current;
      if (timers.has(sessionId)) return;
      timers.set(
        sessionId,
        setTimeout(() => {
          timers.delete(sessionId);
          save(sessionId);
        }, TRANSCRIPT_SAVE_INTERVAL_MS),
      );
    },
    [save],
  );
  const scheduleSaveRef = useLatest(scheduleSave);

  // Write what is still pending when the window goes away.
  useEffect(() => {
    const flush = () => {
      const timers = timersRef.current;
      timers.forEach((timer, sessionId) => {
        clearTimeout(timer);
        timers.delete(sessionId);
        save(sessionId);
      });
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [save]);

  const ensureLoaded = useCallback(
    (sessionId: string) => {
      if (requestedRef.current.has(sessionId)) return;
      requestedRef.current.add(sessionId);
      loadingRef.current.add(sessionId);
      loadTranscript(sessionId)
        .then((loaded) =>
          // Messages that arrived while loading come after the saved history.
          setTranscripts((prev) => {
            const live = prev[sessionId] ?? [];
            const savedIds = new Set(loaded.map((m) => m.id));
            return { ...prev, [sessionId]: [...loaded, ...live.filter((m) => !savedIds.has(m.id))] };
          }),
        )
        .catch((error) => {
          unreadableRef.current.add(sessionId);
          onErrorRef.current(
            `Failed to load the conversation; new messages will not be saved over it: ${String(error)}`,
          );
        })
        .finally(() => loadingRef.current.delete(sessionId));
    },
    [onErrorRef],
  );

  const updateMessages = useCallback(
    (sessionId: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      setTranscripts((prev) => ({ ...prev, [sessionId]: updater(prev[sessionId] ?? []) }));
      scheduleSave(sessionId);
    },
    [scheduleSave],
  );

  const removeTranscript = useCallback(
    (sessionId: string) => {
      clearTimeout(timersRef.current.get(sessionId));
      timersRef.current.delete(sessionId);
      requestedRef.current.delete(sessionId);
      setTranscripts((prev) => omitKey(prev, sessionId));
      deleteTranscript(sessionId).catch((error) => {
        onErrorRef.current(`Failed to delete the conversation: ${String(error)}`);
      });
    },
    [onErrorRef],
  );

  return { transcripts, ensureLoaded, updateMessages, removeTranscript };
}
