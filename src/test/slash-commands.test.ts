import { describe, it, expect } from "vitest";
import { matchingCommands } from "../lib/slash-commands";
import type { SlashCommand } from "../types";

const command = (name: string): SlashCommand => ({ name, description: `${name} command` });

const commands: SlashCommand[] = [
  command("superpowers:brainstorming"),
  command("code-review"),
  command("review"),
  command("deploy"),
];

describe("matchingCommands", () => {
  it("finds a command by the start of a segment after a colon", () => {
    expect(matchingCommands(commands, "brainst").map((c) => c.name)).toEqual([
      "superpowers:brainstorming",
    ]);
  });

  it("finds a command by the start of a segment after a dash", () => {
    expect(matchingCommands(commands, "review").map((c) => c.name)).toEqual([
      "review",
      "code-review",
    ]);
  });

  it("keeps prefix matches before segment matches", () => {
    const names = matchingCommands(commands, "code").map((c) => c.name);

    expect(names).toEqual(["code-review"]);
  });

  it("does not match inside a segment", () => {
    expect(matchingCommands(commands, "storm")).toEqual([]);
  });

  it("still matches every command for an empty query", () => {
    expect(matchingCommands(commands, "").map((c) => c.name)).toEqual(commands.map((c) => c.name));
  });
});