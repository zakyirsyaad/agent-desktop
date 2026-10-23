import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createPtyOutputStore, type PtyOutputStore } from '../lib/pty-output-store';

export interface WorkspaceTerminalTab {
  id: string;
  folderPath: string;
  /** 1-based, per folder; kept while the tab is open, so closing tab 1 does not rename tab 2. */
  number: number;
  status: 'live' | 'exited';
}

export interface WorkspaceTerminals {
  output: PtyOutputStore;
  /** A folder's tabs, oldest first. */
  tabsFor: (folderPath: string) => WorkspaceTerminalTab[];
  /** The new tab's id, or null when the shell could not be opened (the user was told). */
  open: (folderPath: string) => Promise<string | null>;
  close: (id: string) => void;
  closeFolder: (folderPath: string) => void;
  send: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => void;
}

type WorkspaceTerminalEvent =
  | { terminalId: string; kind: 'output'; data: string }
  | { terminalId: string; kind: 'exit'; exitCode: number | null };

const NO_TABS: WorkspaceTerminalTab[] = [];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The shells opened in workspace folders. A shell lives in a backend PTY; its
 * screen goes to an output store that the terminal replays, so output never
 * touches React state. Only open, close and exit change the tabs.
 */
export function useWorkspaceTerminals(onNotice: (message: string) => void): WorkspaceTerminals {
  const [tabs, setTabs] = useState<WorkspaceTerminalTab[]>(NO_TABS);
  const [output] = useState<PtyOutputStore>(() => createPtyOutputStore());
  // Mirrors of the state, so events and quick successive opens see the latest value synchronously.
  const tabsRef = useRef<WorkspaceTerminalTab[]>(NO_TABS);
  const closedRef = useRef<Set<string>>(new Set());
  // A shell can exit before `open` resolves and there is no tab to mark yet, so exits are remembered by id.
  const exitedRef = useRef<Set<string>>(new Set());
  const onNoticeRef = useRef(onNotice);

  useEffect(() => {
    onNoticeRef.current = onNotice;
  }, [onNotice]);

  const commit = useCallback((next: WorkspaceTerminalTab[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);

  useEffect(() => {
    // `unlisten` resolves later, so under StrictMode the first listener can outlive its effect.
    let disposed = false;
    const unlisten = listen<WorkspaceTerminalEvent>('workspace-terminal', ({ payload }) => {
      if (disposed || closedRef.current.has(payload.terminalId)) return;
      if (payload.kind === 'output') {
        output.append(payload.terminalId, payload.data);
        return;
      }
      exitedRef.current.add(payload.terminalId);
      if (tabsRef.current.some((tab) => tab.id === payload.terminalId)) {
        commit(
          tabsRef.current.map((tab) => (tab.id === payload.terminalId ? { ...tab, status: 'exited' } : tab)),
        );
      }
    });
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, [output, commit]);

  const open = useCallback(
    async (folderPath: string) => {
      let id: string;
      try {
        id = await invoke<string>('workspace_terminal_open', { path: folderPath });
      } catch (error) {
        onNoticeRef.current(`Could not open a terminal: ${errorText(error)}`);
        return null;
      }
      const inFolder = tabsRef.current.filter((tab) => tab.folderPath === folderPath);
      const number = inFolder.reduce((highest, tab) => Math.max(highest, tab.number), 0) + 1;
      const status = exitedRef.current.has(id) ? 'exited' : 'live';
      commit([...tabsRef.current, { id, folderPath, number, status }]);
      return id;
    },
    [commit],
  );

  const close = useCallback(
    (id: string) => {
      closedRef.current.add(id);
      exitedRef.current.delete(id);
      output.forget(id);
      commit(tabsRef.current.filter((tab) => tab.id !== id));
      // The shell may be ended even when this fails, so the tab goes either way.
      void invoke('workspace_terminal_close', { id }).catch(() => {});
    },
    [output, commit],
  );

  const closeFolder = useCallback(
    (folderPath: string) => {
      for (const tab of tabsRef.current.filter((candidate) => candidate.folderPath === folderPath)) close(tab.id);
    },
    [close],
  );

  const tabsFor = useCallback(
    (folderPath: string) => {
      const inFolder = tabs.filter((tab) => tab.folderPath === folderPath);
      return inFolder.length === 0 ? NO_TABS : inFolder;
    },
    [tabs],
  );

  const send = useCallback((id: string, data: string) => {
    void invoke('send_input', { sessionId: id, data }).catch(() => {});
  }, []);

  const resize = useCallback((id: string, cols: number, rows: number) => {
    void invoke('resize_session', { sessionId: id, cols, rows }).catch(() => {});
  }, []);

  return useMemo(
    () => ({ output, tabsFor, open, close, closeFolder, send, resize }),
    [output, tabsFor, open, close, closeFolder, send, resize],
  );
}
