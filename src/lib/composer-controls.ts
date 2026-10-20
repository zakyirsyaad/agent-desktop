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

/** Modes that let the agent act without asking (shown with a warning icon). */
const RISKY_MODE = /yolo|bypass|dontask|full.?access|danger/i;

export function isRiskyMode(modeId: string | undefined): boolean {
  return modeId !== undefined && RISKY_MODE.test(modeId);
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
export function acpControls(
  info: Pick<AcpSessionInfo, 'modes' | 'configOptions'>,
  actions: AcpControlActions,
): ComposerControls {
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
