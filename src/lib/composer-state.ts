import { acpControls, type ComposerControls } from './composer-controls';
import { draftInfo, type AcpChoices, type AgentOptions } from './acp-draft';
import type { AcpConfigOption } from '../hooks/useAcpSessions';
import type { AcpEngine } from '../hooks/session-engine/useAcpEngine';
import { isAcpSession } from './session-helpers';
import type { AgentProfile, Session, SlashCommand } from '../types';

export interface ComposerState {
  controls: ComposerControls;
  locked: boolean;
}

export interface ComposerInputs {
  session: Session | undefined;
  /** The agent the next message goes to when no session is running: a resumed one's, or the default. */
  draftAgent: AgentProfile | undefined;
  acpChoices: AcpChoices;
  setAcpChoices: (choices: AcpChoices) => void;
  agentOptions: Readonly<Record<string, AgentOptions>> | undefined;
  acp: AcpEngine;
  /**
   * Called for every setting the user picks, with the agent it is for: before
   * a session at once, during one once the agent took it, with what it reports.
   */
  onPick?: (profileId: string, configId: string, value: string, reported?: AcpConfigOption[]) => void;
}

/**
 * What the composer offers: a live ACP session's own modes and options
 * (changed on the fly) or, before the agent runs, the choices for it: the
 * options it reported last time, applied once it is up.
 */
export function composerStateFor(inputs: ComposerInputs): ComposerState {
  const { session, draftAgent, acp } = inputs;
  if (session?.status === 'running') {
    if (isAcpSession(session)) {
      const info = acp.info[session.id];
      const controls = info
        ? acpControls(info, {
            setMode: (modeId) => acp.setMode(session.id, modeId),
            setConfigOption: (configId, value) => {
              void acp.setConfigOption(session.id, configId, value).then((reported) => {
                if (reported) inputs.onPick?.(session.profileId, configId, value, reported);
              });
            },
          })
        : {};
      return { controls, locked: false };
    }
    return { controls: {}, locked: false };
  }
  if (!draftAgent) return { controls: {}, locked: false };
  const options = inputs.agentOptions?.[draftAgent.id];
  if (!options) return { controls: {}, locked: false };
  const { acpChoices: choices, setAcpChoices } = inputs;
  const controls = acpControls(draftInfo(options, choices), {
    setMode: (modeId) => setAcpChoices({ ...choices, modeId }),
    setConfigOption: (configId, value) => {
      setAcpChoices({ ...choices, config: { ...choices.config, [configId]: value } });
      inputs.onPick?.(draftAgent.id, configId, value);
    },
  });
  return { controls, locked: false };
}

export const COMPOSER_PLACEHOLDERS = {
  noWorkspace: 'Open a folder and install an agent to start',
  newSession: 'Message the agent to start a new session...',
  resume: 'Message the agent to continue this session...',
  creatingWorktree: 'Creating a worktree for the session...',
} as const;

const installPlaceholder = (agentName: string, continuesSession: boolean) =>
  `Install ${agentName} to ${continuesSession ? 'continue this session' : 'start a session'}.`;

/** What the empty composer says the next message does; none in a running session. */
export function composerPlaceholder(state: {
  isRunning: boolean;
  isCreatingWorktree: boolean;
  isResumable: boolean;
  canStartSession: boolean;
  /** The draft agent's name while it must be installed before a message can be sent. */
  agentToInstall?: string;
  /** An ended session is shown: once its agent is installed, the next message continues it. */
  isEndedSession?: boolean;
}): string | undefined {
  if (state.isRunning) return undefined;
  if (state.isCreatingWorktree) return COMPOSER_PLACEHOLDERS.creatingWorktree;
  if (!state.isResumable && !state.canStartSession) return COMPOSER_PLACEHOLDERS.noWorkspace;
  if (state.agentToInstall) return installPlaceholder(state.agentToInstall, state.isResumable || Boolean(state.isEndedSession));
  return state.isResumable ? COMPOSER_PLACEHOLDERS.resume : COMPOSER_PLACEHOLDERS.newSession;
}

/**
 * The slash commands the composer offers: a live ACP session's own; before
 * it runs, the ones its agent offered last time.
 */
export function composerCommandsFor(inputs: {
  session: Session | undefined;
  isRunning: boolean;
  liveCommands: SlashCommand[] | undefined;
  draftAgent: AgentProfile | undefined;
  agentOptions: Readonly<Record<string, AgentOptions>> | undefined;
}): SlashCommand[] | undefined {
  if (inputs.isRunning) return isAcpSession(inputs.session) ? inputs.liveCommands : undefined;
  const agent = inputs.draftAgent;
  return agent ? inputs.agentOptions?.[agent.id]?.commands : undefined;
}
