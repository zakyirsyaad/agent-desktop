import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fakeTauriInvoke, type FakeTauriStore } from "./setup";
import { fakeProfiles, makeProfile } from "./fixtures/agents";
import type { Session, Settings } from "../types";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener[]>();
const emitted: { event: string; payload: unknown }[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    return Promise.resolve(() => {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== cb));
    });
  },
  emit: (event: string, payload: unknown) => {
    emitted.push({ event, payload });
    return Promise.resolve();
  },
}));

import App from "../App";
import { PopoutApp } from "../components/PopoutApp";
import { RemovedAgentPanel } from "../components/RemovedAgentPanel";
import { buildSessionSnapshot } from "../lib/popout-bridge";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

async function deliver(event: string, payload: unknown) {
  await act(async () => {
    (listeners.get(event) ?? []).forEach((cb) => cb({ payload }));
  });
}

const gemini = makeProfile({
  id: "gemini",
  name: "Gemini CLI",
  source: "registry",
  detected: true,
  availability: "ready",
});

const geminiSession: Session = {
  id: "s-gem",
  name: "Gemini chat",
  profileId: "gemini",
  cwd: "/Users/test/developer/zorvo",
  status: "terminated",
  createdAt: 1,
  transport: "acp",
};

const REMOVED_NOTICE = "Gemini CLI was removed. Add it again to continue this session.";

/** A saved Gemini CLI session whose agent the user removed. */
function seedRemovedAgentSession() {
  const settings = fakeStore().state.settings as Partial<Settings>;
  settings.enabledAgents = ["claude-acp"];
  settings.removedAgents = ["gemini"];
  fakeStore().state.sessions = [geminiSession];
  fakeStore().transcripts["s-gem"] = [{ id: "m-1", role: "agent", content: "Earlier answer", timestamp: 1 }];
  vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
    cmd === "get_agent_profiles"
      ? Promise.resolve([...structuredClone(fakeProfiles), structuredClone(gemini)])
      : fakeTauriInvoke(cmd, args),
  );
}

async function openRemovedAgentSession() {
  await act(async () => {
    render(<App />);
  });
  await waitFor(() => expect(screen.getAllByText("Gemini chat").length).toBeGreaterThan(0));
  await act(async () => {
    fireEvent.click(screen.getAllByText("Gemini chat")[0]);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  listeners.clear();
  emitted.length = 0;
});

describe("RemovedAgentPanel", () => {
  it("says the agent was removed and adds it again", () => {
    const onAdd = vi.fn();
    render(<RemovedAgentPanel agentName="Gemini CLI" onAdd={onAdd} />);

    expect(screen.getByText(REMOVED_NOTICE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Gemini CLI" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("A saved session of a removed agent", () => {
  it("keeps the transcript, replaces the composer and adds the agent back", async () => {
    seedRemovedAgentSession();
    await openRemovedAgentSession();

    expect(await screen.findByText("Earlier answer")).toBeInTheDocument();
    expect(screen.getByText(REMOVED_NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Prompt" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add Gemini CLI" }));
    });

    await waitFor(() => expect(screen.queryByText(REMOVED_NOTICE)).toBeNull());
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeInTheDocument();
    await waitFor(() =>
      expect((fakeStore().state.settings as Partial<Settings>).enabledAgents).toContain("gemini"),
    );
  });

  it("keeps the composer, with Stop, while the session still runs", async () => {
    seedRemovedAgentSession();
    fakeStore().state.sessions = [{ ...geminiSession, status: "running" }];
    await openRemovedAgentSession();

    expect(await screen.findByText("Earlier answer")).toBeInTheDocument();
    expect(screen.queryByText(REMOVED_NOTICE)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeInTheDocument();
  });

  it("shows the composer for a session whose agent is in use", async () => {
    seedRemovedAgentSession();
    (fakeStore().state.settings as Partial<Settings>).enabledAgents = ["claude-acp", "gemini"];
    (fakeStore().state.settings as Partial<Settings>).removedAgents = [];
    await openRemovedAgentSession();

    expect(await screen.findByText("Earlier answer")).toBeInTheDocument();
    expect(screen.queryByText(REMOVED_NOTICE)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toBeInTheDocument();
  });
});

describe("A popout of a removed agent's session", () => {
  it("carries the agent's name in its snapshot only while the agent is removed", () => {
    expect(buildSessionSnapshot("s-gem", [geminiSession], {}, undefined, "Gemini CLI").removedAgentName).toBe(
      "Gemini CLI",
    );
    expect(buildSessionSnapshot("s-gem", [geminiSession], {}).removedAgentName).toBeNull();
  });

  it("shows the panel instead of the composer and forwards Add", async () => {
    await act(async () => {
      render(<PopoutApp sessionId="s-gem" />);
    });
    await deliver("session-snapshot", {
      sessionId: "s-gem",
      session: geminiSession,
      messages: [{ id: "m-1", role: "agent", content: "Earlier answer", timestamp: 1 }],
      removedAgentName: "Gemini CLI",
    });

    expect(screen.getByText("Earlier answer")).toBeInTheDocument();
    expect(screen.getByText(REMOVED_NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Prompt" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add Gemini CLI" }));
    });
    expect(emitted).toContainEqual({
      event: "popout-action",
      payload: { sessionId: "s-gem", action: { kind: "add-agent" } },
    });
  });

  it("is sent no name by the main window while the session still runs", async () => {
    seedRemovedAgentSession();
    fakeStore().state.sessions = [{ ...geminiSession, status: "running" }];
    await act(async () => {
      render(<App />);
    });

    await deliver("popout-ready", { sessionId: "s-gem" });
    const snapshot = emitted.find((e) => e.event === "session-snapshot")?.payload as { removedAgentName: string | null };
    expect(snapshot.removedAgentName).toBeNull();
  });

  it("is sent the agent's name by the main window, which adds the agent when asked", async () => {
    seedRemovedAgentSession();
    await act(async () => {
      render(<App />);
    });

    await deliver("popout-ready", { sessionId: "s-gem" });
    const snapshot = emitted.find((e) => e.event === "session-snapshot")?.payload as { removedAgentName: string };
    expect(snapshot.removedAgentName).toBe("Gemini CLI");

    await deliver("popout-action", { sessionId: "s-gem", action: { kind: "add-agent" } });
    await waitFor(() =>
      expect((fakeStore().state.settings as Partial<Settings>).enabledAgents).toContain("gemini"),
    );
  });
});
