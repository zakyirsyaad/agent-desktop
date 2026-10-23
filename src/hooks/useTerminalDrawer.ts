import { useRef, useState } from 'react';
import type { WorkspaceTerminals } from './useWorkspaceTerminals';

export interface TerminalDrawerState {
  /** Whether the drawer shows; never while no folder is shown. */
  isOpen: boolean;
  /** The folder whose shell is starting right now, when it is the one the top bar names. */
  startingFor: string | null;
  toggle: () => void;
  hide: () => void;
  /**
   * Starts a shell in a folder unless one is already starting there. Resolves to
   * the new tab's id, or null when none was started (a start is in flight, or
   * opening failed and the user was told).
   */
  startShell: (folderPath: string) => Promise<string | null>;
}

/**
 * Whether the terminal drawer is open for the folder the top bar names. Opening
 * it on a folder without a shell starts one. That happens in the click handler
 * and not in an effect, because StrictMode runs effects twice; a folder whose
 * shell is still starting gets no second one, however the start was asked for.
 */
export function useTerminalDrawer(
  folderPath: string | undefined,
  terminals: Pick<WorkspaceTerminals, 'tabsFor' | 'open'>,
): TerminalDrawerState {
  const [isOpen, setOpen] = useState(false);
  const [starting, setStarting] = useState<readonly string[]>([]);
  // The state lags a click; the ref is what the next click sees.
  const inFlight = useRef<Set<string>>(new Set());

  const startShell = async (folder: string): Promise<string | null> => {
    if (inFlight.current.has(folder)) return null;
    inFlight.current.add(folder);
    setStarting((current) => [...current, folder]);
    try {
      return await terminals.open(folder);
    } finally {
      inFlight.current.delete(folder);
      setStarting((current) => current.filter((candidate) => candidate !== folder));
    }
  };

  const toggle = () => {
    if (!folderPath) return;
    if (!isOpen && terminals.tabsFor(folderPath).length === 0) void startShell(folderPath);
    setOpen(!isOpen);
  };

  return {
    isOpen: isOpen && Boolean(folderPath),
    startingFor: folderPath && starting.includes(folderPath) ? folderPath : null,
    toggle,
    hide: () => setOpen(false),
    startShell,
  };
}
