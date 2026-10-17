import type { AcpModes } from '../hooks/useAcpSessions';
import { isRiskyMode } from './composer-controls';

/** Mode ids that mean "ask before acting", in order of preference. */
const SAFE_MODE_IDS = ['default', 'manual', 'ask', 'read-only'];

/**
 * The mode to switch a freshly started session to, or undefined to leave it.
 *
 * An agent can start in whatever mode the user configured for it elsewhere
 * (Qwen Code in YOLO, for example). The app's default is to ask before
 * acting, so a risky starting mode is switched to the agent's safe one when
 * the agent offers it. The user can still pick the risky mode in the composer.
 */
export function safeModeToApply(modes: AcpModes | null): string | undefined {
  if (!modes || !isRiskyMode(modes.currentModeId)) return undefined;
  const available = new Set(modes.availableModes.map((m) => m.id));
  return SAFE_MODE_IDS.find((id) => available.has(id));
}
