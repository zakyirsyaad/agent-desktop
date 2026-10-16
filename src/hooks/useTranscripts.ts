import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { deleteTranscript, loadTranscript, saveTranscript } from '../lib/persistence';
import { useLatest } from './useLatest';
import { SAVE_DEBOUNCE_MS } from './usePersistedState';

type Transcripts = Record<string, ChatMessage[]>;

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
 * is shown, and saved per session with a debounce after every change.
 */
export function useTranscripts(onError: (message: string) => void): TranscriptsHandle {
  const [transcripts, setTranscripts] = useState<Transcripts>({});
  const transcriptsRef = useLatest(transcripts);
  const onErrorRef = useLatest(onError);
  const requestedRef = useRef(new Set<string>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = timersRef.current;
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, []);

  const scheduleSave = useCallback(
    (sessionId: string) => {
      const timers = timersRef.current;
      clearTimeout(timers.get(sessionId));
      timers.set(
        sessionId,
        setTimeout(() => {
          timers.delete(sessionId);
          saveTranscript(sessionId, transcriptsRef.current[sessionId] ?? []).catch((error) => {
            onErrorRef.current(`Failed to save the conversation: ${String(error)}`);
          });
        }, SAVE_DEBOUNCE_MS),
      );
    },
    [transcriptsRef, onErrorRef],
  );

  const ensureLoaded = useCallback(
    (sessionId: string) => {
      if (requestedRef.current.has(sessionId)) return;
      requestedRef.current.add(sessionId);
      loadTranscript(sessionId)
        .then((loaded) =>
          // Live output that arrived while loading wins over an empty file.
          setTranscripts((prev) => ({
            ...prev,
            [sessionId]: (prev[sessionId]?.length ?? 0) > 0 ? prev[sessionId] : loaded,
          })),
        )
        .catch((error) => {
          onErrorRef.current(`Failed to load the conversation: ${String(error)}`);
        });
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
