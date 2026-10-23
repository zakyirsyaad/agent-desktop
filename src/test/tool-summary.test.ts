import { describe, it, expect } from "vitest";
import { summarizeTools } from "../lib/tool-summary";
import type { ToolExecution } from "../types";

function tool(id: string, kind: string | undefined, status: ToolExecution["status"] = "completed"): ToolExecution {
  return { id, name: id, kind, status };
}

describe("summarizeTools", () => {
  it("names command runs by their count", () => {
    expect(summarizeTools([tool("t1", "execute")])).toBe("Ran a command");
    expect(summarizeTools([tool("t1", "execute"), tool("t2", "execute")])).toBe("Ran 2 commands");
  });

  it("names file reads by their count", () => {
    expect(summarizeTools([tool("t1", "read")])).toBe("Read a file");
    expect(summarizeTools([tool("t1", "read"), tool("t2", "read"), tool("t3", "read")])).toBe("Read 3 files");
  });

  it("names edits and other file work", () => {
    expect(summarizeTools([tool("t1", "edit")])).toBe("Edited a file");
    expect(summarizeTools([tool("t1", "edit"), tool("t2", "edit")])).toBe("Edited 2 files");
    expect(summarizeTools([tool("t1", "delete")])).toBe("Deleted a file");
    expect(summarizeTools([tool("t1", "move")])).toBe("Moved a file");
  });

  it("describes searches and fetches", () => {
    expect(summarizeTools([tool("t1", "search"), tool("t2", "search")])).toBe("Searched the code");
    expect(summarizeTools([tool("t1", "fetch")])).toBe("Fetched a page");
  });

  it("calls everything else a tool", () => {
    expect(summarizeTools([tool("t1", "think")])).toBe("Used a tool");
    expect(summarizeTools([tool("t1", "other"), tool("t2", undefined)])).toBe("Used 2 tools");
  });

  it("joins kinds in the order they first appear, lowercasing the rest", () => {
    const tools = [tool("t1", "read"), tool("t2", "read"), tool("t3", "execute")];

    expect(summarizeTools(tools)).toBe("Read 2 files, ran a command");
  });

  it("marks failed tools", () => {
    const tools = [tool("t1", "execute"), tool("t2", "execute", "failed")];

    expect(summarizeTools(tools)).toBe("Ran 2 commands · 1 failed");
  });

  it("treats a kind that names an object member as a tool", () => {
    expect(summarizeTools([tool("t1", "execute"), tool("t2", "constructor")])).toBe(
      "Ran a command, used a tool",
    );
    expect(summarizeTools([tool("t1", "__proto__")])).toBe("Used a tool");
  });

  it("has nothing to say about no tools", () => {
    expect(summarizeTools([])).toBe("");
  });
});
