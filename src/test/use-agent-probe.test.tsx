import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useAgentProbe } from "../hooks/useAgentProbe";
import { fakeProfiles } from "./fixtures/agents";
import type { AgentProfile } from "../types";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

const agent = (id: string) => fakeProfiles.find((a) => a.id === id) as AgentProfile;
const QWEN = agent("qwen");
const TERMINAL_AGENT = agent("omp");
const CWD = "/Users/test/developer/agent-desktop";

const PROBED = {
  modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "fast",
      options: [{ value: "fast", name: "Fast" }],
    },
  ],
  commands: [{ name: "review", description: "Review the changes" }],
};

function probeCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([cmd]) => cmd === "acp_probe_agent");
}

function deps(overrides: { agent?: AgentProfile; cwd?: string; isKnown?: (id: string) => boolean } = {}) {
  return {
    agent: QWEN,
    cwd: CWD as string | undefined,
    isKnown: (_id: string) => false,
    onProbed: vi.fn(),
    onAuthRequired: vi.fn(),
    ...overrides,
  };
}

describe("useAgentProbe", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks an ACP agent what it offers and remembers its modes, models and commands", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockResolvedValue(structuredClone(PROBED));
    const props = deps();

    const { result } = renderHook(() => useAgentProbe(props));

    await waitFor(() => expect(props.onProbed).toHaveBeenCalledTimes(1));
    expect(probeCalls(spy)[0][1]).toEqual({ profileId: "qwen", cwd: CWD, openSession: true });
    const [profileId, options] = props.onProbed.mock.calls[0];
    expect(profileId).toBe("qwen");
    expect(options.modes?.currentModeId).toBe("default");
    expect(options.configOptions[0].id).toBe("model");
    expect(options.commands).toEqual([{ name: "review", description: "Review the changes" }]);
    expect(result.current.isProbing("qwen")).toBe(false);
  });

  it("says which agent it is asking while it waits", async () => {
    let answer: (value: unknown) => void = () => {};
    vi.spyOn(tauriInternals(), "invoke").mockImplementation(() => new Promise((resolve) => (answer = resolve)));

    const { result } = renderHook(() => useAgentProbe(deps()));

    await waitFor(() => expect(result.current.isProbing("qwen")).toBe(true));
    answer(structuredClone(PROBED));
    await waitFor(() => expect(result.current.isProbing("qwen")).toBe(false));
  });

  it("asks the user to sign in before the first message when the agent needs it", async () => {
    const methods = [{ id: "browser", name: "Sign in with a browser" }];
    vi.spyOn(tauriInternals(), "invoke").mockRejectedValue(`ACP_AUTH_REQUIRED:${JSON.stringify(methods)}`);
    const props = deps();

    renderHook(() => useAgentProbe(props));

    await waitFor(() => expect(props.onAuthRequired).toHaveBeenCalledTimes(1));
    expect(props.onAuthRequired.mock.calls[0]).toEqual([
      "qwen",
      CWD,
      [{ id: "browser", name: "Sign in with a browser", needsSecret: false }],
    ]);
    expect(props.onProbed).not.toHaveBeenCalled();
  });

  it("leaves other failures to the first message, which reports them", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockRejectedValue("npx: command not found");
    const props = deps();

    const { result } = renderHook(() => useAgentProbe(props));

    await waitFor(() => expect(result.current.isProbing("qwen")).toBe(false));
    expect(props.onAuthRequired).not.toHaveBeenCalled();
    expect(props.onProbed).not.toHaveBeenCalled();
  });

  it("asks each agent once, however often it is picked again", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockResolvedValue(structuredClone(PROBED));
    const props = deps();
    const { rerender } = renderHook((p) => useAgentProbe(p), { initialProps: props });
    await waitFor(() => expect(props.onProbed).toHaveBeenCalledTimes(1));

    rerender({ ...props, agent: TERMINAL_AGENT });
    rerender({ ...props, agent: QWEN });

    expect(probeCalls(spy)).toHaveLength(1);
  });

  it("does not ask a terminal agent, or any agent before a folder is chosen", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockResolvedValue(structuredClone(PROBED));

    renderHook(() => useAgentProbe(deps({ agent: TERMINAL_AGENT })));
    renderHook(() => useAgentProbe(deps({ cwd: undefined })));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(probeCalls(spy)).toHaveLength(0);
  });

  it("asks again once the user signed in, to show what the agent offers", async () => {
    const methods = [{ id: "browser", name: "Sign in with a browser" }];
    const spy = vi
      .spyOn(tauriInternals(), "invoke")
      .mockRejectedValueOnce(`ACP_AUTH_REQUIRED:${JSON.stringify(methods)}`)
      .mockResolvedValue(structuredClone(PROBED));
    const props = deps();
    const { result } = renderHook(() => useAgentProbe(props));
    await waitFor(() => expect(props.onAuthRequired).toHaveBeenCalledTimes(1));

    await act(async () => result.current.reprobe("qwen"));

    await waitFor(() => expect(props.onProbed).toHaveBeenCalledTimes(1));
    expect(probeCalls(spy)).toHaveLength(2);
  });

  it("keeps saying an agent is being asked while another agent's answer comes first", async () => {
    const answers = new Map<string, (value: unknown) => void>();
    vi.spyOn(tauriInternals(), "invoke").mockImplementation(
      (_cmd, args) => new Promise((resolve) => answers.set(String(args?.profileId), resolve)),
    );
    const OTHER_ACP = { ...QWEN, id: "codex", name: "Codex" };
    const props = deps();
    const { result, rerender } = renderHook((p) => useAgentProbe(p), { initialProps: props });
    await waitFor(() => expect(answers.has("qwen")).toBe(true));
    rerender({ ...props, agent: OTHER_ACP });
    await waitFor(() => expect(answers.has("codex")).toBe(true));

    await act(async () => answers.get("codex")?.(structuredClone(PROBED)));

    expect(result.current.isProbing("codex")).toBe(false);
    expect(result.current.isProbing("qwen")).toBe(true);
  });

  it("only asks who is signed in when the agent's options are already known, opening no session", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockResolvedValue(structuredClone(PROBED));
    const props = deps({ isKnown: (id) => id === "qwen" });

    renderHook(() => useAgentProbe(props));

    await waitFor(() => expect(props.onProbed).toHaveBeenCalledTimes(1));
    expect(probeCalls(spy)[0][1]).toEqual({ profileId: "qwen", cwd: CWD, openSession: false });
  });
});
