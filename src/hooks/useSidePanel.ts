import { useState } from 'react';
import { useSessionChanges, type SessionChanges } from './useSessionChanges';
import { useDiffStats } from './useDiffStats';
import type { FileStat } from '../lib/diff-stats';

export type SidePanel = 'files' | 'changes' | 'diff';

export interface SidePanelState {
  /** The panel shown right of the chat, if any. */
  open: SidePanel | null;
  toggle: (panel: SidePanel) => void;
  /** Shows `panel`, replacing any other; unlike `toggle` it never closes it. */
  show: (panel: SidePanel) => void;
  close: () => void;
  /** The uncommitted changes in the session's repository, for the Changes panel and its count. */
  changes: SessionChanges;
  /** Per-file line counts against HEAD, for the diff-stat chip; null until the first read. */
  headStats: FileStat[] | null;
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

  const { stats: headStats } = useDiffStats(folderPath, isRepository, 'head', changes.version, onError);

  const show = (panel: SidePanel) => {
    // The list may be stale while the panel is closed (an agent mid-turn): opening reads it afresh.
    // Asking for the diff again (its chip) reads it afresh even while it is open.
    if (panel === 'diff' || (panel === 'changes' && open !== panel)) changes.reload();
    setOpen(panel);
  };
  const toggle = (panel: SidePanel) => (open === panel ? setOpen(null) : show(panel));

  return { open, toggle, show, close: () => setOpen(null), changes, headStats };
}
