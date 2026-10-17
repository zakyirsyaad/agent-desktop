import type { AcpSessionInfo } from '../hooks/useAcpSessions';
import { isRiskyMode } from './composer-controls';

/** Mode ids that mean "ask before acting", in order of preference. */
const SAFE_MODE_IDS = ['default', 'manual', 'ask', 'read-only'];

export type SafeModeChange =
  | { kind: 'mode'; modeId: string }
  | { kind: 'config'; configId: string; value: string };

function safeIdAmong(current: string, available: readonly string[]): string | undefined {
  if (!isRiskyMode(current)) return undefined;
  const offered = new Set(available);
  return SAFE_MODE_IDS.find((id) => offered.has(id));
}

/**
 * The change that puts a freshly started session in a safe mode, or
 * undefined to leave it as it is.
 *
 * An agent can start in whatever mode the user configured for it elsewhere
 * (Qwen Code in YOLO, for example). The app's default is to ask before
 * acting, so a risky starting mode is switched to the agent's safe one when
 * the agent offers it, whether it reports modes or a "mode" config option.
 * The user can still pick the risky mode in the composer.
 */
export function safeModeToApply(info: Pick<AcpSessionInfo, 'modes' | 'configOptions'>): SafeModeChange | undefined {
  if (info.modes) {
    const modeId = safeIdAmong(
      info.modes.currentModeId,
      info.modes.availableModes.map((m) => m.id),
    );
    return modeId ? { kind: 'mode', modeId } : undefined;
  }
  const option = info.configOptions.find((o) => o.category === 'mode');
  if (!option) return undefined;
  const value = safeIdAmong(
    option.currentValue,
    option.options.map((o) => o.value),
  );
  return value ? { kind: 'config', configId: option.id, value } : undefined;
}
