import { describe, it, expect } from "vitest";
import { changesToApply, draftInfo, NO_CHOICES, rememberedChoice, withPreferred, withProbed, type AgentOptions } from "../lib/acp-draft";

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

describe("the model picked last", () => {
  it("starts the next session with it, while the agent still offers it", () => {
    const remembered = { ...qwen, preferredConfig: { model: "qwen3-max" } };

    expect(withPreferred(NO_CHOICES, remembered).config).toEqual({ model: "qwen3-max" });
    expect(changesToApply(qwen, withPreferred(NO_CHOICES, remembered), false)).toEqual([
      { kind: "config", configId: "model", value: "qwen3-max" },
    ]);
  });

  it("gives way to a pick made for this session, and to a model the agent no longer offers", () => {
    const remembered = { ...qwen, preferredConfig: { model: "qwen3-max" } };
    const gone = { ...qwen, preferredConfig: { model: "retired-model" } };

    expect(withPreferred({ config: { model: "qwen3-coder" } }, remembered).config).toEqual({ model: "qwen3-coder" });
    expect(withPreferred(NO_CHOICES, gone).config).toEqual({});
  });

  const withEffort: AgentOptions = {
    ...qwen,
    configOptions: [
      ...qwen.configOptions,
      {
        id: "reasoning_effort",
        name: "Effort",
        category: "thought_level",
        currentValue: "low",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
      { id: "mode", name: "Mode", category: "mode", currentValue: "default", options: [{ value: "yolo", name: "YOLO" }] },
    ],
  };

  it("remembers model and effort picks, not other settings", () => {
    const afterModel = rememberedChoice(withEffort, "model", "qwen3-max");
    expect(afterModel).toEqual({ model: "qwen3-max" });
    expect(rememberedChoice({ ...withEffort, preferredConfig: afterModel ?? {} }, "reasoning_effort", "high")).toEqual({
      model: "qwen3-max",
      reasoning_effort: "high",
    });
    expect(rememberedChoice(withEffort, "mode", "yolo")).toBeNull();
  });

  it("keeps what the agent settled on after a change, such as an effort a model change reset", () => {
    const remembered = { ...withEffort, preferredConfig: { reasoning_effort: "high" } };
    const reported = withEffort.configOptions.map((o) =>
      o.id === "model" ? { ...o, currentValue: "qwen3-max" } : o.id === "reasoning_effort" ? { ...o, currentValue: "low" } : o,
    );

    expect(rememberedChoice(remembered, "model", "qwen3-max", reported)).toEqual({
      model: "qwen3-max",
      reasoning_effort: "low",
    });
  });

  it("applies the model before the effort, whose choices depend on it", () => {
    const choices = { config: { reasoning_effort: "high", model: "qwen3-max" } };

    expect(changesToApply(withEffort, choices, false)).toEqual([
      { kind: "config", configId: "model", value: "qwen3-max" },
      { kind: "config", configId: "reasoning_effort", value: "high" },
    ]);
  });
});

describe("withProbed", () => {
  const probed = {
    modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
    configOptions: [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Fast" }] },
    ],
    commands: [{ name: "review", description: "Review the changes" }],
  } as unknown as Required<Pick<AgentOptions, "modes" | "configOptions" | "commands">>;

  it("fills in what an agent that never ran offers", () => {
    expect(withProbed(undefined, probed)).toEqual(probed);
  });

  it("keeps what a session reported: it is newer than a probe that started before it", () => {
    const known: AgentOptions = {
      modes: null,
      configOptions: [{ ...probed.configOptions[0], currentValue: "smart" }],
      commands: [{ name: "init", description: "Set up the project" }],
      preferredConfig: { model: "smart" },
    };

    expect(withProbed(known, probed)).toEqual({ ...known, modes: probed.modes });
  });

  it("does not empty remembered commands when the probe heard none", () => {
    const commands = [{ name: "init", description: "Set up the project" }];
    const known: AgentOptions = { modes: null, configOptions: [], commands };

    expect(withProbed(known, { ...probed, commands: [] }).commands).toEqual(commands);
  });
});
