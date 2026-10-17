import { useEffect, useRef, useState } from 'react';
import { useSessionChanges, type SessionChanges } from './useSessionChanges';

export type SidePanel = 'files' | 'changes';

export interface SidePanelState {
  /** The panel shown right of the chat, if any. */
  open: SidePanel | null;
  toggle: (panel: SidePanel) => void;
  close: () => void;
  /** The uncommitted changes in the session's repository, for the Changes panel and its count. */
  changes: SessionChanges;
}

/**
 * The panel beside the chat (the session's files or its uncommitted changes)
 * and the changes it shows, read again whenever the active agent stops working.
 */
export function useSidePanel(
  folderPath: string | undefined,
  isRepository: boolean,
  isActiveBusy: boolean,
  onError: (message: string) => void,
): SidePanelState {
  const [open, setOpen] = useState<SidePanel | null>(null);
  // Counts the active agent's finished turns, so the changes are read again after each.
  const [turnsEnded, setTurnsEnded] = useState(0);
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (wasBusyRef.current && !isActiveBusy) setTurnsEnded((n) => n + 1);
    wasBusyRef.current = isActiveBusy;
  }, [isActiveBusy]);
  const changes = useSessionChanges(folderPath, isRepository, turnsEnded, onError);

  const toggle = (panel: SidePanel) => {
    // The list may be stale while the panel is closed (an agent mid-turn): opening reads it afresh.
    if (panel === 'changes' && open !== 'changes') changes.reload();
    setOpen((current) => (current === panel ? null : panel));
  };

  return { open, toggle, close: () => setOpen(null), changes };
}
