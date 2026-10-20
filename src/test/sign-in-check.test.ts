import { describe, it, expect, vi, afterEach } from "vitest";
import { checkSignIn } from "../lib/sign-in-check";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function internals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

/** Answers the probe with `answer`, passing the rest to the fake backend. */
function mockProbe(answer: () => Promise<unknown>) {
  const real = internals().invoke;
  return vi
    .spyOn(internals(), "invoke")
    .mockImplementation((cmd, args) => (cmd === "acp_probe_agent" ? answer() : real(cmd, args)));
}

describe("checkSignIn", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the agent only whether someone is signed in, and says signed in when it answers", async () => {
    const spy = mockProbe(() => Promise.resolve({ signInChecked: true }));

    await expect(checkSignIn("qwen-code", "/work")).resolves.toBe("signed-in");
    const probes = spy.mock.calls.filter(([cmd]) => cmd === "acp_probe_agent");
    expect(probes.map(([, args]) => args)).toEqual([{ profileId: "qwen-code", cwd: "/work", needsOptions: false }]);
  });

  it("says signed out when the agent still asks for a sign-in", async () => {
    mockProbe(() => Promise.reject("ACP_AUTH_REQUIRED:[]"));

    await expect(checkSignIn("qwen-code", "/work")).resolves.toBe("signed-out");
  });

  it("trusts the sign-in when the agent cannot be asked for another reason", async () => {
    mockProbe(() => Promise.reject("npx not found"));

    await expect(checkSignIn("qwen-code", "/work")).resolves.toBe("signed-in");
  });
});
