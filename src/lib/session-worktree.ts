import { invoke } from '@tauri-apps/api/core';
import type { Session, SessionWorktree } from '../types';

/** A new session's worktree of `repoPath`, and the folder its agent runs in. */
export async function createSessionWorktree(
  repoPath: string,
  title: string,
): Promise<{ worktree: SessionWorktree; cwd: string }> {
  const created = await invoke<{ path: string; cwd: string; branch: string }>('create_session_worktree', {
    repoPath,
    title,
  });
  return { worktree: { repoPath, path: created.path, branch: created.branch }, cwd: created.cwd };
}

/**
 * Removes a deleted session's worktree when no other session runs in it,
 * once its agent has stopped: never from under a running agent. The backend
 * keeps one with uncommitted changes, and its branch always. Resolves with a
 * notice for the user when the worktree was kept, or null.
 */
export async function removeSessionWorktree(
  session: Session,
  otherSessions: readonly Session[],
  stopped: Promise<boolean>,
): Promise<string | null> {
  const worktree = session.worktree;
  if (!worktree) return null;
  if (otherSessions.some((s) => s.id !== session.id && s.worktree?.path === worktree.path)) return null;
  if (!(await stopped)) return `Kept the worktree of "${session.name}": its agent could not be stopped.`;
  try {
    await invoke('remove_session_worktree', { repoPath: worktree.repoPath, path: worktree.path });
    return null;
  } catch (error) {
    return `Kept the worktree of "${session.name}": ${String(error)}`;
  }
}
