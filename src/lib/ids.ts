const SUFFIX_LENGTH = 5;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
/** The largest multiple of 36 a byte can reach; bytes from here up would bias the suffix. */
const UNBIASED_LIMIT = 256 - (256 % BASE36.length);

/**
 * A short unique id with a readable prefix, e.g. "msg-1729150000000-k3x9a".
 * Session ids reach the backend that runs the agent, so the random part comes
 * from the platform's secure generator rather than Math.random, and each
 * character is equally likely.
 */
export function createId(prefix: string): string {
  let suffix = "";
  while (suffix.length < SUFFIX_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SUFFIX_LENGTH))) {
      if (byte < UNBIASED_LIMIT && suffix.length < SUFFIX_LENGTH) suffix += BASE36[byte % BASE36.length];
    }
  }
  return `${prefix}-${Date.now()}-${suffix}`;
}
