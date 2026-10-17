import type { AgentProfile, PermissionMode } from '../types';
import type { AcpSessionInfo } from '../hooks/useAcpSessions';
import type { DropdownOption } from '../components/composer/OptionDropdown';

/** One composer dropdown: the choices, the current one, and what picking does. */
export interface ComposerControl {
  options: DropdownOption[];
  selected: string | undefined;
  onChange: (value: string | undefined) => void;
}

export interface ComposerControls {
  permission?: ComposerControl;
  model?: ComposerControl;
  effort?: ComposerControl;
}

/** Choices for the next terminal session, edited before it starts. */
export interface SessionDraft {
  model?: string;
  effort?: string;
  permissionMode: PermissionMode;
}

/** Modes that let the agent act without asking (shown with a warning icon). */
const RISKY_MODE = /yolo|bypass|dontask|full.?access|danger/i;

export function isRiskyMode(modeId: string | undefined): boolean {
  return modeId !== undefined && RISKY_MODE.test(modeId);
}

function withDefault(defaultLabel: string, values: readonly string[]): DropdownOption[] {
  return [{ value: undefined, label: defaultLabel }, ...values.map((v) => ({ value: v, label: v }))];
}

/** `undefined` when there is nothing real to choose from. */
function controlIf(options: DropdownOption[], minimum: number, rest: Omit<ComposerControl, 'options'>) {
  return options.length >= minimum ? { options, ...rest } : undefined;
}

export interface AcpControlActions {
  setMode: (modeId: string) => void;
  setConfigOption: (configId: string, value: string) => void;
}

/** Controls for an ACP session: exactly what its agent reported, applied live. */
export function acpControls(info: AcpSessionInfo, actions: AcpControlActions): ComposerControls {
  const byCategory = (category: string) => info.configOptions.find((o) => o.category === category);
  const fromConfig = (category: string): ComposerControl | undefined => {
    const option = byCategory(category);
    if (!option) return undefined;
    return controlIf(
      option.options.map((c) => ({ value: c.value, label: c.name })),
      1,
      { selected: option.currentValue, onChange: (value) => value && actions.setConfigOption(option.id, value) },
    );
  };

  const permission = info.modes
    ? controlIf(
        info.modes.availableModes.map((m) => ({ value: m.id, label: m.name })),
        1,
        { selected: info.modes.currentModeId, onChange: (value) => value && actions.setMode(value) },
      )
    : fromConfig('mode');

  return { permission, model: fromConfig('model'), effort: fromConfig('thought_level') };
}

/** Controls for the next terminal session, from the flags its profile declares. */
export function ptyDraftControls(
  agent: AgentProfile,
  draft: SessionDraft,
  onChange: (draft: SessionDraft) => void,
): ComposerControls {
  return {
    permission: controlIf(
      agent.permission_modes.map((m) => ({ value: m.id, label: m.label })),
      1,
      { selected: draft.permissionMode, onChange: (value) => value && onChange({ ...draft, permissionMode: value }) },
    ),
    model: controlIf(withDefault('Default model', agent.models), 2, {
      selected: draft.model,
      onChange: (model) => onChange({ ...draft, model }),
    }),
    effort: controlIf(
      withDefault('Default effort', agent.effort_levels.map((e) => e.label)),
      2,
      { selected: draft.effort, onChange: (effort) => onChange({ ...draft, effort }) },
    ),
  };
}

/** A running terminal session's choices: fixed, because CLI flags only apply at start. */
export function ptySessionControls(
  agent: AgentProfile,
  session: { model?: string; effort?: string; permissionMode?: PermissionMode },
): ComposerControls {
  return ptyDraftControls(
    agent,
    { model: session.model, effort: session.effort, permissionMode: session.permissionMode ?? 'ask' },
    () => {},
  );
}
