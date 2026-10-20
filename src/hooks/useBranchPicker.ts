import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { BranchControl } from '../components/composer/FolderPicker';
import { liveSessionsIn } from '../lib/branch-switch';
import type { Session } from '../types';

export interface BranchPickerInput {
  /** The new session's folder. */
  folderPath: string | undefined;
  /** The folder's checked-out branch; undefined outside a repository. */
  checkedOut: string | undefined;
  isWorktreeOn: boolean;
  sessions: readonly Session[];
  /** The folder's branch changed, so its details should be read again. */
  onSwitched: () => void;
  onNotice: (message: string) => void;
}

export interface BranchPicker {
  /** The folder picker's Branch row; undefined outside a repository. */
  control: BranchControl | undefined;
  /** The branch a new worktree starts from, when one was picked; undefined means the folder's HEAD. */
  baseBranch: string | undefined;
}

/**
 * The branch a new session starts on. With Worktree off, picking a branch
 * switches the folder itself, unless a live agent runs there; with Worktree
 * on, it only picks the branch the session's worktree starts from.
 */
export function useBranchPicker({
  folderPath,
  checkedOut,
  isWorktreeOn,
  sessions,
  onSwitched,
  onNotice,
}: BranchPickerInput): BranchPicker {
  const [listed, setListed] = useState<{ path: string; branches: readonly string[] } | null>(null);
  // Kept with its folder, so another folder never starts from this one's branch.
  const [base, setBase] = useState<{ path: string; branch: string } | null>(null);

  if (!folderPath || !checkedOut) return { control: undefined, baseBranch: undefined };

  const baseBranch = isWorktreeOn && base?.path === folderPath ? base.branch : undefined;
  const branches = listed?.path === folderPath ? listed.branches : null;

  const load = () => {
    invoke<string[]>('list_branches', { path: folderPath })
      .then((names) => setListed({ path: folderPath, branches: names }))
      .catch((error) => {
        setListed({ path: folderPath, branches: [] });
        onNotice(`Could not list the branches: ${String(error)}`);
      });
  };

  const switchFolder = async (branch: string) => {
    if (branch === checkedOut) return;
    const live = liveSessionsIn(folderPath, sessions);
    if (live.length > 0) {
      onNotice(
        `Did not switch to ${branch}: ${live.map((s) => `"${s.name}"`).join(', ')} still runs in this folder. Stop it first, or turn on Worktree.`,
      );
      return;
    }
    try {
      await invoke('switch_branch', { path: folderPath, branch });
      onSwitched();
    } catch (error) {
      onNotice(`Could not switch to ${branch}: ${String(error)}`);
    }
  };

  return {
    control: {
      current: baseBranch ?? checkedOut,
      branches,
      onOpen: load,
      onPick: (branch) => {
        if (isWorktreeOn) setBase({ path: folderPath, branch });
        else return switchFolder(branch);
      },
    },
    baseBranch,
  };
}
