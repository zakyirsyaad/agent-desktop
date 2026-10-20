import { describe, it, expect, vi, afterEach } from "vitest";
import { fakeTauriInvoke } from "./setup";

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import { installEntryOf, resetAgentInstalls, startInstall, startUpdate } from "../lib/agent-installs";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function callsTo(spy: { mock: { calls: unknown[][] } }, cmd: string) {
  return spy.mock.calls.filter(([name]) => name === cmd);
}

describe("startUpdate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAgentInstalls();
  });

  it("calls update_agent and reports the new version", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "update_agent" ? Promise.resolve("1.1.0") : fakeTauriInvoke(cmd, args),
    );
    const onUpdated = vi.fn();

    startUpdate("codex-acp", onUpdated);
    expect(installEntryOf("codex-acp")).toMatchObject({ status: "installing", action: "update" });

    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledWith("1.1.0"));
    expect(callsTo(spy, "update_agent")[0][1]).toEqual({ agentId: "codex-acp" });
    await vi.waitFor(() => expect(installEntryOf("codex-acp").status).toBe("idle"));
  });

  it("stays running until the new version is recorded, and fails with the reason it could not be", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "update_agent" ? Promise.resolve("1.1.0") : fakeTauriInvoke(cmd, args),
    );
    let failRecord: (error: Error) => void = () => {};
    const onUpdated = vi.fn(() => new Promise<void>((_, reject) => (failRecord = reject)));

    startUpdate("codex-acp", onUpdated);
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledWith("1.1.0"));
    expect(installEntryOf("codex-acp").status).toBe("installing");

    failRecord(new Error("Could not save version 1.1.0: disk full"));

    await vi.waitFor(() => expect(installEntryOf("codex-acp").status).toBe("failed"));
    expect(installEntryOf("codex-acp")).toMatchObject({ error: "Could not save version 1.1.0: disk full", action: "update" });
  });

  it("starts one job when called twice, or while an install runs", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "update_agent" || cmd === "install_agent" ? new Promise(() => {}) : fakeTauriInvoke(cmd, args),
    );

    startUpdate("codex-acp", vi.fn());
    startUpdate("codex-acp", vi.fn());
    startInstall("gemini");
    startUpdate("gemini", vi.fn());

    await vi.waitFor(() => expect(callsTo(spy, "update_agent")).toHaveLength(1));
    await vi.waitFor(() => expect(callsTo(spy, "install_agent")).toHaveLength(1));
    expect(callsTo(spy, "update_agent")).toHaveLength(1);
  });

  it("shows the error of a failed update", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "update_agent" ? Promise.reject("Download failed") : fakeTauriInvoke(cmd, args),
    );
    const onUpdated = vi.fn();

    startUpdate("codex-acp", onUpdated);

    await vi.waitFor(() => expect(installEntryOf("codex-acp").status).toBe("failed"));
    expect(installEntryOf("codex-acp")).toMatchObject({ error: "Download failed", action: "update" });
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("settles a cancelled update to idle without reporting a version", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "update_agent" ? Promise.reject("INSTALL_CANCELLED") : fakeTauriInvoke(cmd, args),
    );
    const onUpdated = vi.fn();

    startUpdate("codex-acp", onUpdated);

    await vi.waitFor(() => expect(installEntryOf("codex-acp").status).toBe("idle"));
    expect(installEntryOf("codex-acp").error).toBeNull();
    expect(onUpdated).not.toHaveBeenCalled();
  });
});
