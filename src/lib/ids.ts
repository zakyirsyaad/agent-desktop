const SUFFIX_LENGTH = 5;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A short unique id with a readable prefix, e.g. "msg-1729150000000-k3x9a".
 * Session ids reach the backend that runs the agent, so the random part comes
 * from the platform's secure generator rather than Math.random.
 */
export function createId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SUFFIX_LENGTH));
  const suffix = Array.from(bytes, (byte) => BASE36[byte % BASE36.length]).join("");
  return `${prefix}-${Date.now()}-${suffix}`;
}
