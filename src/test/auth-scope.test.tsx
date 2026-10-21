import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import type { FakeTauriStore } from "./setup";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
  emit: () => Promise.resolve(),
}));

import App from "../App";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

const CLAUDE_METHODS = [{ id: "claude-ai-login", name: "Claude Subscription", type: "terminal" }];

async function pickAgent(name: string) {
  const chip = await screen.findByRole("button", { name: /^Agent: / });
  await act(async () => {
    fireEvent.click(chip);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("option", { name }));
  });
}

async function send(text: string) {
  const prompt = screen.getByRole("textbox", { name: "Prompt" });
  await act(async () => {
    fireEvent.change(prompt, { target: { value: text } });
    fireEvent.keyDown(prompt, { key: "Enter" });
  });
}

describe("the sign-in panel follows the agent on screen", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("hides another agent's request in a new session, and shows it again in the agent's session", async () => {
    fakeStore().state.settings.defaultAgentId = "qwen-code";
    const realInvoke = tauriInternals().invoke;
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "acp_start_session"
        ? Promise.reject(`ACP_AUTH_REQUIRED:${JSON.stringify(CLAUDE_METHODS)}`)
        : realInvoke(cmd, args),
    );
    await act(async () => {
      render(<App />);
    });

    await pickAgent("Claude Code");
    await send("hello");

    expect(await screen.findByRole("region", { name: "Sign in to Claude Code" })).toBeDefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });

    await waitFor(() => expect(screen.queryByRole("region", { name: "Sign in to Claude Code" })).toBeNull());

    await act(async () => {
      fireEvent.click(within(screen.getByRole("complementary")).getByText("hello"));
    });

    expect(await screen.findByRole("region", { name: "Sign in to Claude Code" })).toBeDefined();
  });
});