import type { AcpConfigOption, AcpModes, AcpSessionInfo } from '../hooks/useAcpSessions';
import { safeModeToApply, type SafeModeChange } from './acp-modes';
import type { SlashCommand } from '../types';

/** The modes and config options an ACP agent reported, remembered per agent. */
export interface AgentOptions {
  modes: AcpModes | null;
  configOptions: AcpConfigOption[];
  commands?: SlashCommand[];
  /** The model the user picked last, by config id, to start the next session with. */
  preferredConfig?: Readonly<Record<string, string>>;
}

/** What the user picked in the composer before the agent runs: a mode and config values by id. */
export interface AcpChoices {
  modeId?: string;
  config: Readonly<Record<string, string>>;
}

export const NO_CHOICES: AcpChoices = { config: {} };

export type AcpChange = SafeModeChange;

/**
 * What the composer shows before the agent runs: the options it reported
 * last time, with the user's picks, and the safe mode the session will be
 * switched to when the user picked none.
 */
/** The categories of setting a pick of is kept for the next session: the model. */
const REMEMBERED_CATEGORIES = new Set(['model']);

/**
 * The user's picks plus the model they picked last, while the agent still
 * offers it: agents such as Qwen Code change the model for one session only,
 * so without this every new session would start on the agent's default.
 */
export function withPreferred(choices: AcpChoices, options: AgentOptions | undefined): AcpChoices {
  const preferred = Object.entries(options?.preferredConfig ?? {}).filter(([configId, value]) =>
    options?.configOptions.find((o) => o.id === configId)?.options.some((c) => c.value === value),
  );
  if (preferred.length === 0) return choices;
  return { ...choices, config: { ...Object.fromEntries(preferred), ...choices.config } };
}

/** The remembered picks after the user picked `value` for `configId`, or null when that setting is not kept. */
export function rememberedChoice(
  options: AgentOptions | undefined,
  configId: string,
  value: string,
): Record<string, string> | null {
  const category = options?.configOptions.find((o) => o.id === configId)?.category;
  if (!category || !REMEMBERED_CATEGORIES.has(category)) return null;
  return { ...options?.preferredConfig, [configId]: value };
}

export function draftInfo(options: AgentOptions, choices: AcpChoices): Pick<AcpSessionInfo, 'modes' | 'configOptions'> {
  const safe = safeModeToApply(options);
  const modes = options.modes && {
    ...options.modes,
    currentModeId: choices.modeId ?? (safe?.kind === 'mode' ? safe.modeId : options.modes.currentModeId),
  };
  const configOptions = options.configOptions.map((option) => {
    const safeValue = safe?.kind === 'config' && safe.configId === option.id ? safe.value : undefined;
    return { ...option, currentValue: choices.config[option.id] ?? safeValue ?? option.currentValue };
  });
  return { modes, configOptions };
}

/**
 * Changes to send once the agent is up: the user's picks, or the safe mode
 * when the user picked no mode. Picks the agent no longer offers and values
 * that already hold are skipped.
 */
export function changesToApply(
  info: Pick<AcpSessionInfo, 'modes' | 'configOptions'>,
  choices: AcpChoices,
  applySafeMode: boolean,
): AcpChange[] {
  const changes: AcpChange[] = [];
  const pickedMode = choices.modeId;
  if (pickedMode && info.modes) {
    const offered = info.modes.availableModes.some((m) => m.id === pickedMode);
    if (offered && pickedMode !== info.modes.currentModeId) changes.push({ kind: 'mode', modeId: pickedMode });
  }
  for (const [configId, value] of Object.entries(choices.config)) {
    const option = info.configOptions.find((o) => o.id === configId);
    const offered = option?.options.some((o) => o.value === value);
    if (option && offered && option.currentValue !== value) changes.push({ kind: 'config', configId, value });
  }
  const pickedAModeConfig = info.configOptions.some((o) => o.category === 'mode' && o.id in choices.config);
  if (applySafeMode && !pickedMode && !pickedAModeConfig) {
    const safe = safeModeToApply(info);
    if (safe) changes.push(safe);
  }
  return changes;
}
