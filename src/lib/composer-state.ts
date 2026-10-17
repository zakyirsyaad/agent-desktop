import { acpControls, ptyDraftControls, ptySessionControls, type ComposerControls, type SessionDraft } from './composer-controls';
import { draftInfo, type AcpChoices, type AgentOptions } from './acp-draft';
import type { AcpEngine } from '../hooks/session-engine/useAcpEngine';
import { TRANSPORT_ACP, type AgentProfile, type Session } from '../types';

export interface ComposerState {
  controls: ComposerControls;
  locked: boolean;
}

export interface ComposerInputs {
  session: Session | undefined;
  sessionAgent: AgentProfile | undefined;
  /** The agent the next message goes to when no session is running: a resumed one's, or the default. */
  draftAgent: AgentProfile | undefined;
  draft: SessionDraft;
  setDraft: (draft: SessionDraft) => void;
  acpChoices: AcpChoices;
  setAcpChoices: (choices: AcpChoices) => void;
  agentOptions: Readonly<Record<string, AgentOptions>> | undefined;
  acp: AcpEngine;
  /** Called for every setting the user picks, before or during a session, with the agent it is for. */
  onPick?: (profileId: string, configId: string, value: string) => void;
}

/**
 * What the composer offers: a live ACP session's own modes and options
 * (changed on the fly), a running terminal session's fixed flags, or, before
 * the agent runs, the choices for it. For an ACP agent those are the options
 * it reported last time; they are applied once it is up.
 */
export function composerStateFor(inputs: ComposerInputs): ComposerState {
  const { session, sessionAgent, draftAgent, acp } = inputs;
  if (session?.status === 'running') {
    if (session.transport === TRANSPORT_ACP) {
      const info = acp.info[session.id];
      const controls = info
        ? acpControls(info, {
            setMode: (modeId) => acp.setMode(session.id, modeId),
            setConfigOption: (configId, value) => {
              acp.setConfigOption(session.id, configId, value);
              inputs.onPick?.(session.profileId, configId, value);
            },
          })
        : {};
      return { controls, locked: false };
    }
    return { controls: sessionAgent ? ptySessionControls(sessionAgent, session) : {}, locked: true };
  }
  if (!draftAgent) return { controls: {}, locked: false };
  if (draftAgent.transport !== TRANSPORT_ACP) {
    return { controls: ptyDraftControls(draftAgent, inputs.draft, inputs.setDraft), locked: false };
  }
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
