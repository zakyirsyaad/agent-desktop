/** Silence after which an agent that is still running counts as waiting for input. */
export const AGENT_IDLE_AFTER_MS = 1500;

/** True while the agent produced output less than `idleAfterMs` ago. */
export function isAgentBusy(
  lastOutputAt: number | null,
  now: number,
  idleAfterMs: number = AGENT_IDLE_AFTER_MS,
): boolean {
  if (lastOutputAt === null) return false;
  return now - lastOutputAt < idleAfterMs;
}
