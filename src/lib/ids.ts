/** A short unique id with a readable prefix, e.g. "msg-1729150000000-k3x9a". */
export function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
