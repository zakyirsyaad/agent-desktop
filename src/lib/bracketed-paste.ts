/**
 * Bracketed paste: a TUI that turns it on (ESC[?2004h) is told where pasted
 * text starts and ends, so an Enter after the end marker submits even when
 * text and Enter arrive in one read. Without it, text and Enter that arrive
 * together read as a paste and the Enter stays in the prompt.
 */
const SWITCH_ON = "\x1b[?2004h";
const SWITCH_OFF = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ENTER = "\r";
/** Enough of a chunk's end to finish a switch the next chunk completes. */
const TAIL_LENGTH = SWITCH_ON.length - 1;

export interface PasteMode {
  isOn: boolean;
  /** The end of the output so far, for a switch split across chunks. */
  tail: string;
}

export const INITIAL_PASTE_MODE: PasteMode = { isOn: false, tail: "" };

/** The paste mode after an agent printed `data`: its last switch wins. */
export function nextPasteMode(mode: PasteMode, data: string): PasteMode {
  const text = mode.tail + data;
  const on = text.lastIndexOf(SWITCH_ON);
  const off = text.lastIndexOf(SWITCH_OFF);
  const isOn = on === off ? mode.isOn : on > off;
  return { isOn, tail: text.slice(-TAIL_LENGTH) };
}

/**
 * The writes that type `text` into an agent and submit it. Bracketed, it is
 * one write; otherwise Enter goes in a second write, after a pause.
 */
export function typedMessage(text: string, isPasteModeOn: boolean): string[] {
  return isPasteModeOn ? [`${PASTE_START}${text}${PASTE_END}${ENTER}`] : [text, ENTER];
}
