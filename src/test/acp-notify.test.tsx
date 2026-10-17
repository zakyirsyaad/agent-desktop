import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
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

const notifications = vi.hoisted(() => ({ sent: [] as { title: string; body?: string }[] }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: (options: { title: string; body?: string }) => notifications.sent.push(options),
}));

import App from "../App";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
const internals = () => (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
const fakeStore = () => (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;

async function startQwenAndSend(text: string): Promise<string> {
  fakeStore().state.settings.defaultAgentId = "qwen";
  const spy = vi.spyOn(internals(), "invoke");
  await act(async () => {
    render(<App />);
  });
  const prompt = screen.getByRole("textbox", { name: "Prompt" });
  await act(async () => {
    fireEvent.change(prompt, { target: { value: text } });
    fireEvent.keyDown(prompt, { key: "Enter" });
  });
  await waitFor(() => expect(spy.mock.calls.some(([cmd]) => cmd === "acp_prompt")).toBe(true));
  const start = spy.mock.calls.find(([cmd]) => cmd === "acp_start_session");
  return String((start?.[1] as { sessionId?: string })?.sessionId);
}

async function acpEvent(payload: Record<string, unknown>) {
  await act(async () => {
    listeners.get("acp-event")?.({ payload });
  });
}

describe("Notifications", () => {
  beforeEach(() => {
    notifications.sent.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("notifies when an agent needs an answer or finishes while the app is in the background", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const sessionId = await startQwenAndSend("clean up the build");

    await acpEvent({
      sessionId,
      kind: "permission",
      requestId: 1,
      toolCall: { title: "Delete build" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });

    await waitFor(() => expect(notifications.sent).toHaveLength(2));
    expect(notifications.sent[0]).toMatchObject({ title: "clean up the build", body: expect.stringMatching(/needs your answer/i) });
    expect(notifications.sent[1]).toMatchObject({ body: expect.stringMatching(/finished/i) });
  });

  it("stays quiet while the user is looking at the app", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const sessionId = await startQwenAndSend("hi");

    await acpEvent({ sessionId, kind: "turn-end", stopReason: "end_turn" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notifications.sent).toHaveLength(0);
  });
});
