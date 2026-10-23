import { useRef, useState } from 'react';
import type { WorkspaceTerminals } from './useWorkspaceTerminals';

export interface TerminalDrawerState {
  /** Whether the drawer shows; never while no folder is shown. */
  isOpen: boolean;
  toggle: () => void;
  hide: () => void;
}

/**
 * Whether the terminal drawer is open for the folder the top bar names. Opening
 * it on a folder without a shell starts one. That happens in the click handler
 * and not in an effect, because StrictMode runs effects twice; a folder whose
 * first shell is still starting gets no second one.
 */
export function useTerminalDrawer(
  folderPath: string | undefined,
  terminals: Pick<WorkspaceTerminals, 'tabsFor' | 'open'>,
): TerminalDrawerState {
  const [isOpen, setOpen] = useState(false);
  const opening = useRef<Set<string>>(new Set());

  const toggle = () => {
    if (!folderPath) return;
    if (!isOpen && terminals.tabsFor(folderPath).length === 0 && !opening.current.has(folderPath)) {
      opening.current.add(folderPath);
      void terminals.open(folderPath).finally(() => opening.current.delete(folderPath));
    }
    setOpen(!isOpen);
  };

  return { isOpen: isOpen && Boolean(folderPath), toggle, hide: () => setOpen(false) };
}
