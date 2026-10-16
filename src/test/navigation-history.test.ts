import { describe, it, expect } from "vitest";
import {
  canStepBack,
  canStepForward,
  createNavigationHistory,
  currentEntry,
  removeEntry,
  stepBack,
  stepForward,
  visitEntry,
} from "../lib/navigation-history";

/** Walks a list of ids through `visitEntry` so cases read as a session order. */
function historyOf(...ids: string[]) {
  return ids.reduce(
    (state, id) => visitEntry(state, id),
    createNavigationHistory()
  );
}

describe("navigation-history reducer", () => {
  it("starts empty with no current entry and no available steps", () => {
    const state = createNavigationHistory();

    expect(state.entries).toEqual([]);
    expect(state.index).toBe(-1);
    expect(currentEntry(state)).toBeNull();
    expect(canStepBack(state)).toBe(false);
    expect(canStepForward(state)).toBe(false);
  });

  it("starts on the initial id when one is given", () => {
    const state = createNavigationHistory("s-1");

    expect(state.entries).toEqual(["s-1"]);
    expect(currentEntry(state)).toBe("s-1");
    expect(canStepBack(state)).toBe(false);
    expect(canStepForward(state)).toBe(false);
  });

  it("appends visited ids and moves the cursor to the newest entry", () => {
    const state = historyOf("s-1", "s-2", "s-3");

    expect(state.entries).toEqual(["s-1", "s-2", "s-3"]);
    expect(currentEntry(state)).toBe("s-3");
    expect(canStepBack(state)).toBe(true);
    expect(canStepForward(state)).toBe(false);
  });

  it("treats visiting the current id as a no-op", () => {
    const state = historyOf("s-1", "s-2");

    const next = visitEntry(state, "s-2");

    expect(next).toBe(state);
    expect(next.entries).toEqual(["s-1", "s-2"]);
    expect(currentEntry(next)).toBe("s-2");
    expect(canStepForward(next)).toBe(false);
  });

  it("does not grow history when re-visiting the current id after stepping back and forward", () => {
    const stepped = stepBack(historyOf("s-1", "s-2"));
    const backOnCurrent = stepForward(stepped);

    const next = visitEntry(backOnCurrent, "s-2");

    expect(next.entries).toEqual(["s-1", "s-2"]);
    expect(next.index).toBe(1);
  });

  it("steps back and forward through visited ids", () => {
    const state = historyOf("s-1", "s-2", "s-3");

    const atSecond = stepBack(state);
    expect(currentEntry(atSecond)).toBe("s-2");
    expect(canStepBack(atSecond)).toBe(true);
    expect(canStepForward(atSecond)).toBe(true);

    const atFirst = stepBack(atSecond);
    expect(currentEntry(atFirst)).toBe("s-1");
    expect(canStepBack(atFirst)).toBe(false);
    expect(canStepForward(atFirst)).toBe(true);

    expect(currentEntry(stepForward(atFirst))).toBe("s-2");
  });

  it("clamps at both ends instead of falling off the history", () => {
    const state = historyOf("s-1", "s-2");

    const beforeFirst = stepBack(stepBack(state));
    expect(currentEntry(beforeFirst)).toBe("s-1");
    expect(canStepBack(beforeFirst)).toBe(false);

    expect(canStepForward(stepForward(state))).toBe(false);
    expect(currentEntry(stepForward(state))).toBe("s-2");
  });

  it("returns unchanged state when stepping back on an empty history", () => {
    const state = createNavigationHistory();

    expect(stepBack(state)).toBe(state);
    expect(stepForward(state)).toBe(state);
    expect(currentEntry(stepBack(state))).toBeNull();
  });

  it("drops the forward entries when visiting a new id after stepping back", () => {
    // s-1 -> s-2 -> s-3, then back to s-2; visiting s-4 must discard s-3.
    const state = stepBack(historyOf("s-1", "s-2", "s-3"));
    expect(currentEntry(state)).toBe("s-2");

    const next = visitEntry(state, "s-4");

    expect(next.entries).toEqual(["s-1", "s-2", "s-4"]);
    expect(currentEntry(next)).toBe("s-4");
    expect(canStepForward(next)).toBe(false);
    expect(canStepBack(next)).toBe(true);
  });

  it("allows re-visiting an id that already appears earlier in the history", () => {
    const next = visitEntry(historyOf("s-1", "s-2"), "s-1");

    expect(next.entries).toEqual(["s-1", "s-2", "s-1"]);
    expect(next.index).toBe(2);
    expect(currentEntry(next)).toBe("s-1");
  });

  it("never mutates the state it was given", () => {
    const state = historyOf("s-1", "s-2", "s-3");
    const frozenEntries = [...state.entries];

    visitEntry(state, "s-4");
    stepBack(state);
    stepForward(state);
    removeEntry(state, "s-2");

    expect(state.entries).toEqual(frozenEntries);
    expect(state.index).toBe(2);
  });

  describe("removeEntry", () => {
    it("removes a non-current id and keeps the cursor on the same session", () => {
      const state = historyOf("s-1", "s-2", "s-3");

      const next = removeEntry(state, "s-2");

      expect(next.entries).toEqual(["s-1", "s-3"]);
      expect(currentEntry(next)).toBe("s-3");
      expect(next.index).toBe(1);
    });

    it("steps back to the previous entry when the current id is removed", () => {
      const state = historyOf("s-1", "s-2", "s-3");
      const atSecond = stepBack(state);
      expect(currentEntry(atSecond)).toBe("s-2");

      const next = removeEntry(atSecond, "s-2");

      expect(next.entries).toEqual(["s-1", "s-3"]);
      expect(currentEntry(next)).toBe("s-1");
      expect(next.index).toBe(0);
      expect(canStepForward(next)).toBe(true);
    });

    it("moves to the remaining entry when the first of two is removed", () => {
      const state = historyOf("s-1", "s-2");
      const atFirst = stepBack(state);

      const next = removeEntry(atFirst, "s-1");

      expect(next.entries).toEqual(["s-2"]);
      expect(currentEntry(next)).toBe("s-2");
      expect(next.index).toBe(0);
      expect(canStepBack(next)).toBe(false);
      expect(canStepForward(next)).toBe(false);
    });

    it("empties the history when the only entry is removed", () => {
      const next = removeEntry(createNavigationHistory("s-1"), "s-1");

      expect(next.entries).toEqual([]);
      expect(next.index).toBe(-1);
      expect(currentEntry(next)).toBeNull();
      expect(canStepBack(next)).toBe(false);
      expect(canStepForward(next)).toBe(false);
    });

    it("drops every occurrence of a session visited more than once", () => {
      // s-1 -> s-2 -> s-1, so "s-1" appears at both ends of the history.
      const state = historyOf("s-1", "s-2", "s-1");

      const next = removeEntry(state, "s-1");

      expect(next.entries).toEqual(["s-2"]);
      expect(currentEntry(next)).toBe("s-2");
      expect(next.index).toBe(0);
    });

    it("steps back to the surviving predecessor when the current id is a duplicate", () => {
      const state = historyOf("s-1", "s-2", "s-3", "s-2");

      const next = removeEntry(state, "s-2");

      expect(next.entries).toEqual(["s-1", "s-3"]);
      // The cursor sat on the trailing "s-2", so it lands on the entry that
      // preceded it once both "s-2" occurrences are gone.
      expect(currentEntry(next)).toBe("s-3");
      expect(next.index).toBe(1);
    });

    it("returns the same state when the id is not in the history", () => {
      const state = historyOf("s-1", "s-2");

      expect(removeEntry(state, "s-9")).toBe(state);
    });

    it("is a no-op on an empty history", () => {
      const state = createNavigationHistory();

      const next = removeEntry(state, "s-1");

      expect(next.entries).toEqual([]);
      expect(next.index).toBe(-1);
    });
  });
});
