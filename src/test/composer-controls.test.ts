import { describe, it, expect, vi } from "vitest";
import { acpControls, isRiskyMode } from "../lib/composer-controls";
import type { AcpSessionInfo } from "../hooks/useAcpSessions";

const info: AcpSessionInfo = {
  acpSessionId: "acp-1",
  isBusy: false,
  canFork: false,
  canReopen: false,
  commands: [],
  modes: {
    currentModeId: "default",
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
      currentValue: "qwen-max",
      options: [
        { value: "qwen-max", name: "Qwen Max" },
        { value: "qwen-flash", name: "Qwen Flash" },
      ],
    },
  ],
};

describe("composer controls", () => {
  it("treats bypass-style modes as risky and asking modes as safe", () => {
    for (const id of ["yolo", "bypass", "bypassPermissions", "dontAsk", "full-access"]) {
      expect(isRiskyMode(id), id).toBe(true);
    }
    for (const id of ["ask", "default", "plan", "manual", "auto-edit"]) {
      expect(isRiskyMode(id), id).toBe(false);
    }
  });

  it("builds ACP controls from what the agent reported, changeable live", () => {
    const setMode = vi.fn();
    const setConfig = vi.fn();
    const controls = acpControls(info, { setMode, setConfigOption: setConfig });

    expect(controls.permission?.options.map((o) => o.label)).toEqual(["Default", "YOLO"]);
    expect(controls.permission?.selected).toBe("default");
    expect(controls.model?.options.map((o) => o.label)).toEqual(["Qwen Max", "Qwen Flash"]);
    expect(controls.model?.selected).toBe("qwen-max");
    expect(controls.effort).toBeUndefined();

    controls.permission?.onChange("yolo");
    controls.model?.onChange("qwen-flash");
    expect(setMode).toHaveBeenCalledWith("yolo");
    expect(setConfig).toHaveBeenCalledWith("model", "qwen-flash");
  });

  it("falls back to a mode config option when the agent reports no modes", () => {
    const withModeOption: AcpSessionInfo = {
      ...info,
      modes: null,
      configOptions: [
        { id: "mode", name: "Mode", category: "mode", currentValue: "ask", options: [{ value: "ask", name: "Ask" }] },
      ],
    };
    const setConfig = vi.fn();

    const controls = acpControls(withModeOption, { setMode: vi.fn(), setConfigOption: setConfig });
    controls.permission?.onChange("ask");

    expect(controls.permission?.selected).toBe("ask");
    expect(setConfig).toHaveBeenCalledWith("mode", "ask");
  });
});
