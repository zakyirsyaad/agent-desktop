/** Matches the backend's prefix for "this agent needs a sign-in" errors. */
export const AUTH_REQUIRED_PREFIX = 'ACP_AUTH_REQUIRED:';

/**
 * How the app handles a sign-in method: `agent` runs inside the agent
 * (authenticate), `terminal` is a login command the app runs in a terminal
 * for the agent, `explain` needs a secret the app never asks for.
 */
export type AuthMethodKind = 'agent' | 'terminal' | 'explain';

/** A way to sign in that the agent offers. */
export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
  kind: AuthMethodKind;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function methodKind(method: Json): AuthMethodKind {
  if (method.type === 'terminal') return 'terminal';
  const meta = isObject(method._meta) ? method._meta : {};
  if (meta.type === 'terminal' || 'api-key' in meta || /api.?key/i.test(String(method.id))) return 'explain';
  return 'agent';
}

function toAuthMethods(raw: unknown): AuthMethod[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).flatMap((method) => {
    if (typeof method.id !== 'string' || typeof method.name !== 'string') return [];
    return [
      {
        id: method.id,
        name: method.name,
        ...(typeof method.description === 'string' ? { description: method.description } : {}),
        kind: methodKind(method),
      },
    ];
  });
}

/** The agent's sign-in methods when `error` says it needs a sign-in, otherwise null. */
export function parseAuthRequired(error: unknown): AuthMethod[] | null {
  if (typeof error !== 'string' || !error.startsWith(AUTH_REQUIRED_PREFIX)) return null;
  try {
    return toAuthMethods(JSON.parse(error.slice(AUTH_REQUIRED_PREFIX.length)));
  } catch {
    return [];
  }
}
