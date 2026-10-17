import { describe, it, expect } from "vitest";
import { changesToApply, draftInfo, NO_CHOICES, type AgentOptions } from "../lib/acp-draft";

const qwen: AgentOptions = {
  modes: {
    currentModeId: "yolo",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "yolo", name: "YOLO" },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "qwen3-coder",
      options: [
        { value: "qwen3-coder", name: "Qwen3 Coder" },
        { value: "qwen3-max", name: "Qwen3 Max" },
      ],
    },
  ],
};

describe("draftInfo", () => {
  it("shows the agent's last options, starting in the safe mode", () => {
    const info = draftInfo(qwen, NO_CHOICES);

    expect(info.modes?.currentModeId).toBe("default");
    expect(info.configOptions[0].currentValue).toBe("qwen3-coder");
  });

  it("shows what the user picked", () => {
    const info = draftInfo(qwen, { modeId: "yolo", config: { model: "qwen3-max" } });

    expect(info.modes?.currentModeId).toBe("yolo");
    expect(info.configOptions[0].currentValue).toBe("qwen3-max");
  });
});

describe("changesToApply", () => {
  it("applies the safe mode when the user picked nothing", () => {
    expect(changesToApply(qwen, NO_CHOICES, true)).toEqual([{ kind: "mode", modeId: "default" }]);
  });

  it("applies the user's picks instead of the safe mode, skipping what already holds", () => {
    expect(changesToApply(qwen, { modeId: "yolo", config: { model: "qwen3-max" } }, true)).toEqual([
      { kind: "config", configId: "model", value: "qwen3-max" },
    ]);
    expect(changesToApply(qwen, { modeId: "default", config: { model: "qwen3-coder" } }, true)).toEqual([
      { kind: "mode", modeId: "default" },
    ]);
  });

  it("ignores picks the agent no longer offers", () => {
    expect(changesToApply(qwen, { modeId: "plan", config: { model: "gpt-9", effort: "high" } }, false)).toEqual([]);
  });

  it("leaves the mode alone when asked to keep it, as for a fork", () => {
    expect(changesToApply(qwen, NO_CHOICES, false)).toEqual([]);
  });
});
