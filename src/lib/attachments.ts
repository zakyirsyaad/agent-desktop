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

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSION.test(path);
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Adds paths not attached yet, keeping their order. */
export function withAttachments(current: readonly string[], paths: readonly string[]): string[] {
  return [...current, ...paths.filter((p, i) => !current.includes(p) && paths.indexOf(p) === i)];
}
