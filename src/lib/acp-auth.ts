/** Matches the backend's prefix for "this agent needs a sign-in" errors. */
export const AUTH_REQUIRED_PREFIX = 'ACP_AUTH_REQUIRED:';

/** A way to sign in that the agent offers. */
export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
  /**
   * True when the user must provide a secret (an API key) or run a terminal
   * command; the app never asks for secrets, so it only explains these.
   */
  needsSecret: boolean;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function needsSecret(method: Json): boolean {
  const meta = isObject(method._meta) ? method._meta : {};
  return meta.type === 'terminal' || 'api-key' in meta || /api.?key/i.test(String(method.id));
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
        needsSecret: needsSecret(method),
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
