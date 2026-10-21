/** Starts the backend's error when the agent itself answered `session/load` or `session/resume` with an error. */
const SESSION_REFUSED_PREFIXES = ['session/load failed:', 'session/resume failed:'];

/**
 * True when the agent answered `session/load` or `session/resume` that it does
 * not know the session (ACP's "Resource not found", or an agent's own "not
 * found"), as opposed to an agent error or an answer that never came. Only
 * then is there no earlier conversation in the agent that a fresh session
 * would lose.
 */
export function isUnknownSessionError(error: unknown): boolean {
  return (
    typeof error === 'string' &&
    SESSION_REFUSED_PREFIXES.some((prefix) => error.startsWith(prefix)) &&
    /not found/i.test(error)
  );
}
