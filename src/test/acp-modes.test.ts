import { describe, it, expect } from "vitest";
import { safeModeToApply } from "../lib/acp-modes";

const mode = (id: string) => ({ id, name: id });

describe("safeModeToApply", () => {
  it("switches a risky starting mode to the agent's safe mode", () => {
    expect(safeModeToApply({ currentModeId: "yolo", availableModes: [mode("plan"), mode("default"), mode("yolo")] })).toBe("default");
    expect(safeModeToApply({ currentModeId: "bypassPermissions", availableModes: [mode("manual"), mode("bypassPermissions")] })).toBe("manual");
  });

  it("leaves a safe starting mode alone", () => {
    expect(safeModeToApply({ currentModeId: "plan", availableModes: [mode("plan"), mode("default")] })).toBeUndefined();
  });

  it("leaves the mode alone when the agent offers no safe alternative or no modes", () => {
    expect(safeModeToApply({ currentModeId: "yolo", availableModes: [mode("yolo")] })).toBeUndefined();
    expect(safeModeToApply(null)).toBeUndefined();
  });
});
