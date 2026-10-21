import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDraftAgentCheck } from "../hooks/useDraftAgentCheck";
import { fakeProfiles } from "./fixtures/agents";
import type { AgentAuth } from "../hooks/useAgentAuth";
import type { AgentProfile } from "../types";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

const QWEN = fakeProfiles.find((a) => a.id === "qwen-code") as AgentProfile;
const CWD = "/Users/test/developer/zorvo";

/** A sign-in panel already up for Qwen Code, waiting for the user. */
const pendingSignIn: AgentAuth = {
  authRequest: { profileId: "qwen-code", cwd: CWD, methods: [], status: "idle" },
  requestSignIn: () => {},
  signIn: () => {},
  dismiss: () => {},
};

const probeCalls = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([cmd]) => cmd === "acp_probe_agent");

describe("useDraftAgentCheck", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("asks a signed-out agent again at most once in a while, however often the window regains focus", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockRejectedValue(`ACP_AUTH_REQUIRED:${JSON.stringify([])}`);
    renderHook(() =>
      useDraftAgentCheck({ agent: QWEN, cwd: CWD, agentOptions: undefined, rememberProbed: () => {}, auth: pendingSignIn }),
    );
    await waitFor(() => expect(probeCalls(spy)).toHaveLength(1));

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
    }

    await waitFor(() => expect(probeCalls(spy)).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probeCalls(spy)).toHaveLength(2);
  });

  it("remembers that the agent can list its sessions, from its probe answer", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockResolvedValue({ signInChecked: true, canListSessions: true });

    const { result } = renderHook(() =>
      useDraftAgentCheck({ agent: QWEN, cwd: CWD, agentOptions: undefined, rememberProbed: () => {}, auth: pendingSignIn }),
    );

    expect(result.current.canListSessions("qwen-code")).toBe(false);

    await waitFor(() => expect(result.current.canListSessions("qwen-code")).toBe(true));
    expect(result.current.canListSessions("codex-acp")).toBe(false);
  });
});
