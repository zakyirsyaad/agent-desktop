import { invoke } from '@tauri-apps/api/core';
import type { AcpEngine, FirstMessage } from './session-engine/useAcpEngine';
import { buildForkHandoff, buildForkPrompt } from '../lib/fork-handoff';
import { createId } from '../lib/ids';
import { spawnOptionsFor, type SessionSpec } from '../lib/session-start';
import type { SessionDraft } from '../lib/composer-controls';
import { isAcpSession } from '../lib/session-helpers';
import { DEFAULT_PERMISSION_MODE, type AgentProfile, type ChatMessage, type Session } from '../types';

export interface SessionForkDeps {
  /** The session forked from: the one open. */
  source: Session | undefined;
  agents: readonly AgentProfile[];
  transcripts: Readonly<Record<string, ChatMessage[]>>;
  acp: Pick<AcpEngine, 'canFork' | 'fork'>;
  recordSession: (spec: SessionSpec) => Session;
  startSession: (spec: SessionSpec, first?: FirstMessage) => void;
  onNotice: (message: string) => void;
}

/**
 * Forks the open session at a message. From the latest message, an ACP
 * agent that supports it forks its own live session, and Claude Code in a
 * terminal resumes and forks its session natively. Otherwise the
 * conversation is written to a handoff file and the new agent is asked, in
 * one line, to read it.
 */
export function useSessionFork(deps: SessionForkDeps): (messageId: string) => Promise<void> {
  const { source, agents, transcripts, acp, recordSession, startSession, onNotice } = deps;

  return async (messageId: string) => {
    const agent = agents.find((a) => a.id === source?.profileId);
    if (!source || !agent?.detected) {
      onNotice('The agent for this session is not installed, so it cannot be forked.');
      return;
    }
    const messages = transcripts[source.id] ?? [];
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0) return;

    const isAcp = isAcpSession(source);
    const isLatest = index === messages.length - 1;
    const baseOptions: SessionDraft = {
      model: source.model,
      effort: source.effort,
      permissionMode: source.permissionMode ?? DEFAULT_PERMISSION_MODE,
    };
    const spec: SessionSpec = {
      id: createId('s'),
      agent,
      cwd: source.cwd,
      name: `${source.name} (fork)`,
      forkedFrom: source.id,
      // A fork works in the same checkout as its source.
      worktree: source.worktree,
      initialMessages: messages.slice(0, index + 1),
    };
    // A native fork needs the source agent alive; after it exited, fall back to a handoff.
    if (isAcp && source.status === 'running' && isLatest && acp.canFork(source.id)) {
      void acp.fork(source.id, recordSession(spec));
      return;
    }
    if (!isAcp && agent.fork_support === 'native' && isLatest && source.agentSessionId) {
      startSession({ ...spec, options: { ...baseOptions, forkFromAgentSessionId: source.agentSessionId } });
      return;
    }

    try {
      const content = buildForkHandoff(messages, messageId, {
        sourceSessionName: source.name,
        agentName: agent.name,
        cwd: source.cwd,
        createdAt: Date.now(),
      });
      const handoffPath = await invoke<string>('write_fork_handoff', { handoffId: spec.id, content });
      startSession({ ...spec, options: spawnOptionsFor(agent, baseOptions) }, { text: buildForkPrompt(handoffPath) });
    } catch (error) {
      onNotice(`Could not fork the session: ${String(error)}`);
    }
  };
}
