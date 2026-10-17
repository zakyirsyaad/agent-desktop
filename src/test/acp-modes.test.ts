import { describe, it, expect } from "vitest";
import { safeModeToApply } from "../lib/acp-modes";
import type { AcpConfigOption, AcpModes } from "../hooks/useAcpSessions";

const mode = (id: string) => ({ id, name: id });
const withModes = (modes: AcpModes | null) => ({ modes, configOptions: [] });

function modeConfig(currentValue: string, values: string[]): AcpConfigOption {
  return {
    id: "mode",
    name: "Approval",
    category: "mode",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

describe("safeModeToApply", () => {
  it("switches a risky starting mode to the agent's safe mode", () => {
    expect(
      safeModeToApply(withModes({ currentModeId: "yolo", availableModes: [mode("plan"), mode("default"), mode("yolo")] }))
    ).toEqual({ kind: "mode", modeId: "default" });
    expect(
      safeModeToApply(withModes({ currentModeId: "bypassPermissions", availableModes: [mode("manual"), mode("bypassPermissions")] }))
    ).toEqual({ kind: "mode", modeId: "manual" });
  });

  it("switches an agent whose mode is a config option", () => {
    expect(
      safeModeToApply({ modes: null, configOptions: [modeConfig("full-access", ["read-only", "full-access"])] })
    ).toEqual({ kind: "config", configId: "mode", value: "read-only" });
  });

  it("leaves a safe starting mode alone", () => {
    expect(safeModeToApply(withModes({ currentModeId: "plan", availableModes: [mode("plan"), mode("default")] }))).toBeUndefined();
    expect(safeModeToApply({ modes: null, configOptions: [modeConfig("read-only", ["read-only", "full-access"])] })).toBeUndefined();
  });

  it("leaves the mode alone when the agent offers no safe alternative or no modes", () => {
    expect(safeModeToApply(withModes({ currentModeId: "yolo", availableModes: [mode("yolo")] }))).toBeUndefined();
    expect(safeModeToApply(withModes(null))).toBeUndefined();
  });
});
