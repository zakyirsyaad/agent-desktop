/**
 * Thin wrapper over the Web Speech API (`speechSynthesis`) for reading agent
 * replies aloud, plus a pure helper that turns Markdown into speakable text.
 */

/** Spoken in place of a fenced code block, which is noise when read aloud. */
export const CODE_BLOCK_PLACEHOLDER = "code block omitted";

const FENCE_PATTERN = /^\s*```/;
const HEADING_PATTERN = /^#{1,6} /;
const INLINE_CODE_PATTERN = /`([^`]*)`/g;
const BOLD_PATTERN = /\*\*([^*]+)\*\*/g;

export interface SpeakOptions {
  onEnd?: () => void;
}

/** True when the platform exposes both the speech engine and the utterance class. */
export function isSpeechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.speechSynthesis != null &&
    typeof globalThis.SpeechSynthesisUtterance !== "undefined"
  );
}

/** Speaks `text`, cancelling any utterance already in progress. */
export function speak(text: string, options: SpeakOptions = {}): void {
  if (!isSpeechSupported()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const handleEnd = () => options.onEnd?.();
  utterance.onend = handleEnd;
  utterance.onerror = handleEnd;
  window.speechSynthesis.speak(utterance);
}

/** Stops any utterance in progress. */
export function stopSpeaking(): void {
  if (!isSpeechSupported()) return;
  window.speechSynthesis.cancel();
}

/** Replaces each fenced block with the placeholder; an unclosed fence runs to the end. */
function omitCodeBlocks(lines: readonly string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_PATTERN.test(line)) {
      if (!inFence) out.push(CODE_BLOCK_PLACEHOLDER);
      inFence = !inFence;
    } else if (!inFence) {
      out.push(line);
    }
  }
  return out;
}

function stripInlineMarkdown(line: string): string {
  return line
    .replace(HEADING_PATTERN, "")
    .replace(BOLD_PATTERN, "$1")
    .replace(INLINE_CODE_PATTERN, "$1");
}

/** Converts Markdown to plain text suitable for speech synthesis. */
export function toSpeakableText(markdown: string): string {
  return omitCodeBlocks(markdown.split("\n"))
    .map(stripInlineMarkdown)
    .join("\n")
    .trim();
}
