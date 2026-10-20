import type { Session } from '../types';

/** Whether `path` is `folder` or inside it. */
function isWithin(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * The sessions whose agent is alive and works in `folder`'s own checkout:
 * switching its branch would change the files under them. A session in a
 * worktree has its own checkout, and an ended one has no agent left.
 */
export function liveSessionsIn(folder: string, sessions: readonly Session[]): Session[] {
  return sessions.filter(
    (s) => s.status !== 'terminated' && !s.worktree && (isWithin(s.cwd, folder) || isWithin(folder, s.cwd)),
  );
}
