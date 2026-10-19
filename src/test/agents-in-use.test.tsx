import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import type { FakeTauriStore } from "./setup";
import { fakeProfiles, makeProfile } from "./fixtures/agents";
import App from "../App";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

const kimi = makeProfile({ id: "kimi", name: "Kimi CLI", source: "registry", transport: "acp", detected: true });
const gemini = makeProfile({ id: "gemini", name: "Gemini CLI", source: "registry", transport: "acp", detected: true });

/** Kimi is enabled; Gemini is ready to run but the user never enabled it. */
async function renderWithRegistryAgents() {
  const settings = fakeStore().state.settings as FakeTauriStore["state"]["settings"] & { enabledAgents?: string[] };
  settings.enabledAgents = ["claude-acp", "kimi"];
  const originalInvoke = tauriInternals().invoke;
  vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
    cmd === "get_agent_profiles"
      ? Promise.resolve([...structuredClone(fakeProfiles), kimi, gemini])
      : originalInvoke(cmd, args),
  );
  await act(async () => {
    render(<App />);
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("Agents in use", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers only the agents in use in the new-session agent picker", async () => {
    await renderWithRegistryAgents();
    await click(screen.getByRole("button", { name: "+ New session" }));

    await click(screen.getByRole("button", { name: "Agent: Claude Code" }));

    const names = screen.getAllByRole("option").map((option) => option.textContent);
    expect(names).toEqual(expect.arrayContaining(["Claude Code", "Kimi CLI", "Oh-My-Pi"]));
    expect(names).not.toContain("Gemini CLI");
    expect(names).not.toContain("Qwen Code");
  });

  it("offers only the agents in use as the default agent in Settings", async () => {
    await renderWithRegistryAgents();

    await click(within(screen.getByRole("complementary")).getByRole("button", { name: "Settings" }));

    const select = within(screen.getByRole("combobox", { name: "Default agent" }));
    const names = select.getAllByRole("option").map((option) => option.textContent);
    expect(names).toEqual(expect.arrayContaining(["Claude Code", "Kimi CLI", "Oh-My-Pi"]));
    expect(names).not.toContain("Gemini CLI");
    expect(names).not.toContain("Qwen Code");
  });
});
