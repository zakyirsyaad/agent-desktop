const WHITESPACE = /\s/;

/** Quotes a path that contains whitespace so the agent reads it as one token. */
export function formatAttachmentPath(path: string): string {
  return WHITESPACE.test(path) ? `"${path}"` : path;
}

/** Appends picked file paths to the prompt text, separated by single spaces. */
export function appendAttachments(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const prefix = text.length === 0 || text.endsWith(" ") ? text : `${text} `;
  return `${prefix}${paths.map(formatAttachmentPath).join(" ")} `;
}
