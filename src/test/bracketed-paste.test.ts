import { describe, expect, it } from "vitest";
import { INITIAL_PASTE_MODE, nextPasteMode, typedMessage } from "../lib/bracketed-paste";

const ON = "\x1b[?2004h";
const OFF = "\x1b[?2004l";

describe("nextPasteMode", () => {
  it("starts off", () => {
    expect(INITIAL_PASTE_MODE.isOn).toBe(false);
  });

  it("follows the last switch in a chunk", () => {
    expect(nextPasteMode(INITIAL_PASTE_MODE, `logo${ON}prompt`).isOn).toBe(true);
    expect(nextPasteMode(INITIAL_PASTE_MODE, `${ON}…${OFF}bye`).isOn).toBe(false);
    expect(nextPasteMode(nextPasteMode(INITIAL_PASTE_MODE, ON), "output without a switch").isOn).toBe(true);
  });

  it("finds a switch split across two chunks", () => {
    const first = nextPasteMode(INITIAL_PASTE_MODE, "draw\x1b[?20");
    expect(first.isOn).toBe(false);
    expect(nextPasteMode(first, "04hready").isOn).toBe(true);
  });
});

describe("typedMessage", () => {
  // With paste mode on, the agent sees where the text ends, so Enter can follow in
  // the same write: it submits however the agent's reads split the bytes.
  it("brackets the text and ends with Enter when the agent asked for paste mode", () => {
    expect(typedMessage("run the tests", true)).toEqual(["\x1b[200~run the tests\x1b[201~\r"]);
  });

  it("types the text, then Enter on its own, when it did not", () => {
    expect(typedMessage("run the tests", false)).toEqual(["run the tests", "\r"]);
  });
});
