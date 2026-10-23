import { describe, it, expect } from "vitest";
import { tabLabel } from "../lib/terminal-labels";

describe("tabLabel", () => {
  it("joins the folder and its branch for the first terminal", () => {
    expect(tabLabel("zorvo", "main", 1)).toBe("zorvo · main");
  });

  it("adds the number from the second terminal on", () => {
    expect(tabLabel("zorvo", "main", 2)).toBe("zorvo · main 2");
  });

  it("leaves out the branch when the folder has none", () => {
    expect(tabLabel("zorvo", undefined, 1)).toBe("zorvo");
    expect(tabLabel("zorvo", undefined, 3)).toBe("zorvo 3");
  });
});
