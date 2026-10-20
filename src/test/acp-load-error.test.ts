import { describe, it, expect } from "vitest";
import { isUnknownSessionError } from "../lib/acp-load-error";

describe("isUnknownSessionError", () => {
  it("is true when the agent answers the load that it does not know the session", () => {
    expect(isUnknownSessionError("session/load failed: Resource not found: acp-1")).toBe(true);
    expect(isUnknownSessionError("session/load failed: Session not found")).toBe(true);
  });

  it("is false for any other load error, and for errors that did not come from the agent's answer", () => {
    expect(isUnknownSessionError("session/load failed: Internal error: disk full")).toBe(false);
    expect(isUnknownSessionError("Timed out waiting for session/load")).toBe(false);
    expect(isUnknownSessionError("Failed to spawn 'npx': command not found")).toBe(false);
    expect(isUnknownSessionError(new Error("session/load failed: Resource not found"))).toBe(false);
  });
});
