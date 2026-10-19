/** Starts the backend's error when the agent itself answered `session/load` with an error. */
const LOAD_REFUSED_PREFIX = 'session/load failed:';

/**
 * True when the agent answered `session/load` that it does not know the
 * session (ACP's "Resource not found", or an agent's own "not found"), as
 * opposed to an agent error or a load that never got an answer. Only then is
 * there no earlier conversation in the agent that a fresh session would lose.
 */
export function isUnknownSessionError(error: unknown): boolean {
  return typeof error === 'string' && error.startsWith(LOAD_REFUSED_PREFIX) && /not found/i.test(error);
}
