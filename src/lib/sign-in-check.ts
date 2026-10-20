import { invoke } from '@tauri-apps/api/core';
import { parseAuthRequired } from './acp-auth';

/**
 * Asks an agent, after a sign-in, whether it now has one. Only an agent that
 * still asks for a sign-in says no; one that cannot be asked for another
 * reason (a missing npx, a crash) is trusted, and a later refusal opens the
 * sign-in again.
 */
export async function checkSignIn(profileId: string, cwd: string): Promise<'signed-in' | 'signed-out'> {
  try {
    await invoke('acp_probe_agent', { profileId, cwd, needsOptions: false });
    return 'signed-in';
  } catch (error) {
    return parseAuthRequired(error) ? 'signed-out' : 'signed-in';
  }
}
