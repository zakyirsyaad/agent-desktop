import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within, waitFor } from "@testing-library/react";
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

vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows: () => Promise.resolve([]),
}));

import App from "../App";
import { ELICITATION_GONE } from "../lib/acp-elicitation";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
type InvokeCall = [string, Record<string, unknown> | undefined, ...unknown[]];
type Spy = { mock: { calls: unknown[][] } };

const tauriInternals = () => (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
const fakeStore = () => (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;

function callsTo(spy: Spy, cmd: string) {
  return (spy.mock.calls as unknown as InvokeCall[]).filter(([name]) => name === cmd);
}

async function acpEvent(payload: Record<string, unknown>) {
  await act(async () => {
    listeners.get("acp-event")?.({ payload });
  });
}

/** The fake backend, for mocks that change one command and pass the rest through. */
let realInvoke: TauriInternals["invoke"] = () => Promise.resolve();

async function renderWithQwen() {
  fakeStore().state.settings.defaultAgentId = "qwen";
  realInvoke = tauriInternals().invoke;
  const spy = vi.spyOn(tauriInternals(), "invoke");
  await act(async () => {
    render(<App />);
  });
  return spy;
}

/** Makes one command answer differently; the rest go to the fake backend. */
function override(spy: ReturnType<typeof vi.spyOn>, cmd: string, answer: (args?: Record<string, unknown>) => Promise<unknown>) {
  (spy as unknown as { mockImplementation: (f: TauriInternals["invoke"]) => void }).mockImplementation((name, args) =>
    name === cmd ? answer(args) : realInvoke(name, args),
  );
}

async function send(text: string) {
  const prompt = screen.getByRole("textbox", { name: "Prompt" });
  await act(async () => {
    fireEvent.change(prompt, { target: { value: text } });
    fireEvent.keyDown(prompt, { key: "Enter" });
  });
}

/** Starts a session with a first message; the agent is still working on it. */
async function startWorkingSession(spy: Spy): Promise<string> {
  await send("sign me up");
  await waitFor(() => expect(callsTo(spy, "acp_prompt")).toHaveLength(1));
  return String(callsTo(spy, "acp_start_session")[0][1]?.sessionId);
}

const FORM_REQUEST = {
  mode: "form",
  message: "What is your name?",
  fields: [{ name: "name", title: "Name", required: true, kind: { type: "text" } }],
};

const URL_REQUEST = {
  mode: "url",
  message: "Sign in to Acme",
  url: "https://acme.example/login",
  host: "acme.example",
  warnings: [],
};

const card = (key: string) => within(screen.getByTestId(`elicitation-card-${key}`));

async function askForName(sessionId: string, key = "el-1") {
  await acpEvent({ sessionId, kind: "elicitation", key, request: FORM_REQUEST });
}

async function submitName(key: string, name: string) {
  await act(async () => {
    fireEvent.change(card(key).getByLabelText(/Name/), { target: { value: name } });
  });
  await act(async () => {
    fireEvent.click(card(key).getByRole("button", { name: "Submit" }));
  });
}

describe("Elicitations in the app", () => {
  beforeEach(() => {
    notifications.sent.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("shows_a_card_and_sends_the_answer", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);

    await askForName(sessionId);
    expect(card("el-1").getByText("What is your name?")).toBeDefined();
    await submitName("el-1", "Ada");

    expect(callsTo(spy, "acp_respond_elicitation").map(([, a]) => a)).toEqual([
      { sessionId, key: "el-1", action: "accept", content: { name: "Ada" } },
    ]);
    await waitFor(() => expect(card("el-1").getByText("You sent the form.")).toBeDefined());
  });

  it("reopens_with_field_errors", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);
    override(spy, "acp_respond_elicitation", () =>
      Promise.reject('ELICITATION_INVALID:{"name":"Use the format the agent asked for."}'),
    );

    await askForName(sessionId);
    await submitName("el-1", "Ada");

    await waitFor(() => expect(card("el-1").getByText("Use the format the agent asked for.")).toBeDefined());
    expect(card("el-1").getByRole("button", { name: "Submit" })).toBeDefined();
    expect(card("el-1").queryByText("You sent the form.")).toBeNull();
  });

  it("puts the card back when answering fails for another reason", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);
    override(spy, "acp_respond_elicitation", () => Promise.reject("the pipe broke"));

    await askForName(sessionId);
    await submitName("el-1", "Ada");

    await waitFor(() => expect(screen.getByText("Could not answer the agent: the pipe broke")).toBeDefined());
    expect(card("el-1").getByRole("button", { name: "Submit" })).toBeDefined();
  });

  it("marks_a_gone_request_unanswered", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);
    override(spy, "acp_respond_elicitation", () => Promise.reject(ELICITATION_GONE));

    await askForName(sessionId);
    await act(async () => {
      fireEvent.click(card("el-1").getByRole("button", { name: "Decline" }));
    });

    await waitFor(() => expect(card("el-1").getByText("This request was not answered.")).toBeDefined());
    expect(screen.getAllByText(ELICITATION_GONE).length).toBeGreaterThan(0);
  });

  it("stop_dismisses_open_cards", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);
    await askForName(sessionId);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    });

    expect(callsTo(spy, "acp_cancel").map(([, a]) => a)).toContainEqual({ sessionId });
    await waitFor(() => expect(card("el-1").getByText("You dismissed this request.")).toBeDefined());
  });

  it("does not bring back a card dismissed and then stopped when the late answer fails", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);
    let fail: (reason: unknown) => void = () => {};
    override(spy, "acp_respond_elicitation", () => new Promise((_, reject) => (fail = reject)));
    await askForName(sessionId);

    await act(async () => {
      fireEvent.click(card("el-1").getByRole("button", { name: "Dismiss" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    });
    await act(async () => {
      fail("the pipe broke");
    });

    expect(card("el-1").getByText("You dismissed this request.")).toBeDefined();
    expect(card("el-1").queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("does not bring back an opened card after the agent exits when the late answer fails", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);
    let fail: (reason: unknown) => void = () => {};
    override(spy, "acp_respond_elicitation", () => new Promise((_, reject) => (fail = reject)));
    await acpEvent({ sessionId, kind: "elicitation", key: "el-u", request: URL_REQUEST });

    await act(async () => {
      fireEvent.click(card("el-u").getByRole("button", { name: "Open in browser" }));
    });
    await acpEvent({ sessionId, kind: "exit", code: 1 });
    await act(async () => {
      fail("the pipe broke");
    });

    expect(card("el-u").getByText("This request was not answered.")).toBeDefined();
    expect(card("el-u").queryByRole("button", { name: "Open in browser" })).toBeNull();
  });

  it("exit_and_failed_start_leave_cards_unanswered: the agent exits", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);
    await askForName(sessionId);

    await acpEvent({ sessionId, kind: "exit", code: 1 });

    expect(card("el-1").getByText("This request was not answered.")).toBeDefined();
  });

  it("exit_and_failed_start_leave_cards_unanswered: the start fails after a request arrived", async () => {
    const spy = await renderWithQwen();
    override(spy, "acp_start_session", async (args) => {
      listeners.get("acp-event")?.({
        payload: { sessionId: args?.sessionId, kind: "elicitation", key: "el-9", request: FORM_REQUEST },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      throw "the agent crashed";
    });

    await send("sign me up");

    await waitFor(() => expect(card("el-9").getByText("This request was not answered.")).toBeDefined());
  });

  it("completion_finishes_an_opened_card", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);
    await acpEvent({ sessionId, kind: "elicitation", key: "el-u", request: URL_REQUEST });
    expect(card("el-u").getByText("https://acme.example/login")).toBeDefined();

    await act(async () => {
      fireEvent.click(card("el-u").getByRole("button", { name: "Open in browser" }));
    });
    expect(callsTo(spy, "acp_respond_elicitation").map(([, a]) => a)).toEqual([
      { sessionId, key: "el-u", action: "accept", content: null },
    ]);
    await waitFor(() => expect(card("el-u").getByText("Opened in your browser.")).toBeDefined());

    await act(async () => {
      fireEvent.click(card("el-u").getByRole("button", { name: "Open again" }));
    });
    expect(callsTo(spy, "acp_reopen_elicitation_url").map(([, a]) => a)).toEqual([{ sessionId, key: "el-u" }]);

    await acpEvent({ sessionId, kind: "elicitation-complete", key: "el-u" });
    expect(card("el-u").getByText("Finished in your browser.")).toBeDefined();
  });

  it("ignores a malformed request", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);

    await acpEvent({ sessionId, kind: "elicitation", key: "el-x", request: { mode: "form", message: 3 } });

    expect(screen.queryByTestId("elicitation-card-el-x")).toBeNull();
  });

  it("marks_the_session_as_waiting", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);
    const row = () => within(screen.getByRole("list", { name: /^Sessions in/ })).getAllByRole("listitem")[0];

    await askForName(sessionId);

    expect(within(row()).getByLabelText("Waiting for your answer")).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Background tasks/ }));
    });
    expect(within(screen.getByRole("list", { name: "Running tasks" })).getByText("Needs approval")).toBeDefined();
    await waitFor(() =>
      expect(notifications.sent).toContainEqual(expect.objectContaining({ body: expect.stringMatching(/needs your answer/i) })),
    );

    await submitName("el-1", "Ada");
    expect(within(row()).queryByLabelText("Waiting for your answer")).toBeNull();
  });

  it("never_persists_typed_values", async () => {
    const spy = await renderWithQwen();
    const sessionId = await startWorkingSession(spy);
    await askForName(sessionId);
    const flush = async () => {
      await act(async () => {
        window.dispatchEvent(new Event("pagehide"));
      });
    };

    await act(async () => {
      fireEvent.change(card("el-1").getByLabelText(/Name/), { target: { value: "secret-value" } });
    });
    await flush();
    await act(async () => {
      fireEvent.click(card("el-1").getByRole("button", { name: "Submit" }));
    });
    await waitFor(() => expect(card("el-1").getByText("You sent the form.")).toBeDefined());
    await flush();

    expect(callsTo(spy, "acp_respond_elicitation")[0][1]).toMatchObject({ content: { name: "secret-value" } });
    await waitFor(() => expect(fakeStore().transcripts[sessionId]).toBeDefined());
    expect(JSON.stringify(fakeStore().transcripts[sessionId])).toContain("What is your name?");
    expect(JSON.stringify(window.__FAKE_TAURI_STORE__)).not.toContain("secret-value");
  });
});

declare global {
  interface Window {
    __FAKE_TAURI_STORE__: FakeTauriStore;
  }
}
