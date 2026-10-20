import { invoke } from '@tauri-apps/api/core';
import { buildForkHandoff, buildRewindContext } from './fork-handoff';
import { createId } from './ids';
import type { ChatMessage, Session } from '../types';

/**
 * Writes a session's conversation so far to a handoff file and returns the
 * hidden context that tells a fresh agent to read it first; undefined when
 * there is no conversation to hand over.
 */
export async function writeConversationHandoff(
  session: Session,
  messages: readonly ChatMessage[],
  agentName: string,
  handoffPrefix: string,
): Promise<string | undefined> {
  if (messages.length === 0) return undefined;
  const content = buildForkHandoff(messages, messages[messages.length - 1].id, {
    sourceSessionName: session.name,
    agentName,
    cwd: session.cwd,
    createdAt: Date.now(),
  });
  const handoffPath = await invoke<string>('write_fork_handoff', { handoffId: createId(handoffPrefix), content });
  return buildRewindContext(handoffPath);
}
