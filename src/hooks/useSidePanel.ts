import { useState } from 'react';
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
 * and the changes it shows, read again whenever `turnsEnded` changes.
 */
export function useSidePanel(
  folderPath: string | undefined,
  isRepository: boolean,
  turnsEnded: number,
  onError: (message: string) => void,
): SidePanelState {
  const [open, setOpen] = useState<SidePanel | null>(null);
  const changes = useSessionChanges(folderPath, isRepository, turnsEnded, onError);

  const toggle = (panel: SidePanel) => {
    // The list may be stale while the panel is closed (an agent mid-turn): opening reads it afresh.
    if (panel === 'changes' && open !== 'changes') changes.reload();
    setOpen((current) => (current === panel ? null : panel));
  };

  return { open, toggle, close: () => setOpen(null), changes };
}
