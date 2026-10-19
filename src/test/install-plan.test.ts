import { describe, expect, it } from "vitest";
import { describePhase, describePlan, pickerLabelOf } from "../lib/install-plan";
import type { InstallStep } from "../types";

const MB = 1_048_576;

const node: InstallStep = { kind: "node", name: "Node.js", version: "24.11.1", download_bytes: 49 * MB + 1000 };
const opencode: InstallStep = { kind: "agent", name: "OpenCode", version: "1.19.3", download_bytes: null };
const pi: InstallStep = { kind: "prerequisite", name: "pi", version: "0.9.0", download_bytes: null };

describe("describePlan", () => {
  it("joins two steps with and and shows a runtime's size in MB", () => {
    expect(describePlan([node, opencode])).toBe("Node.js 24.11.1 (49 MB) and OpenCode 1.19.3");
  });

  it("joins three steps with a comma, then and", () => {
    expect(describePlan([node, pi, opencode])).toBe("Node.js 24.11.1 (49 MB), pi 0.9.0 and OpenCode 1.19.3");
  });

  it("leaves out the parentheses for a step without a known size", () => {
    expect(describePlan([opencode])).toBe("OpenCode 1.19.3");
  });

  it("rounds the size to the nearest MB", () => {
    expect(describePlan([{ ...node, download_bytes: 1.6 * MB }])).toBe("Node.js 24.11.1 (2 MB)");
  });
});

describe("describePhase", () => {
  it("names the step for each phase", () => {
    expect(describePhase("download", "Node.js")).toBe("Downloading Node.js…");
    expect(describePhase("verify", "Node.js")).toBe("Checking Node.js…");
    expect(describePhase("unpack", "Node.js")).toBe("Unpacking Node.js…");
    expect(describePhase("npm", "pi")).toBe("Installing pi with npm…");
  });
});

describe("pickerLabelOf", () => {
  it("marks an agent that is not ready as not installed", () => {
    expect(pickerLabelOf({ name: "Codex", availability: "ready" })).toBe("Codex");
    expect(pickerLabelOf({ name: "Codex", availability: "needs_runtime" })).toBe("Codex (not installed)");
    expect(pickerLabelOf({ name: "Codex", availability: "not_installed" })).toBe("Codex (not installed)");
  });
});
