import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import { fakeTauriInvoke, type FakeTauriStore } from "./setup";

const openDialog = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => openDialog(...args) }));

import App from "../App";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

async function renderApp() {
  await act(async () => {
    render(<App />);
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

function sidebar() {
  return within(screen.getByRole("complementary"));
}

describe("First run and project folders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    openDialog.mockReset();
  });

  it("walks a first-time user through setup and saves the result", async () => {
    fakeStore().state.settings.onboardingCompleted = false;
    fakeStore().state.recentFolders = [];
    await renderApp();

    expect(screen.queryByRole("complementary")).toBeNull();
    await click(screen.getByRole("button", { name: "Continue" }));
    await click(
      within(screen.getByRole("list", { name: "Suggested folders" })).getByRole("button", {
        name: /zorvo/,
      })
    );
    await click(screen.getByRole("button", { name: "Continue" }));
    await click(screen.getByRole("button", { name: "Start" }));

    expect(sidebar().getByText("zorvo")).toBeDefined();
    await waitFor(() => {
      const { settings, recentFolders } = fakeStore().state;
      expect(settings.onboardingCompleted).toBe(true);
      expect(settings.defaultAgentId).toBe("claude-acp");
      expect((recentFolders as { path: string }[])[0].path).toBe("/Users/test/developer/zorvo");
    });
  });

  it("skips setup for a returning user and lists their recent folders", async () => {
    await renderApp();

    expect(screen.queryByRole("heading", { name: "Check your agents" })).toBeNull();
    expect(sidebar().getByText("ai-perpetual-trading")).toBeDefined();
    expect(sidebar().getByText("titan-investment")).toBeDefined();
  });

  it("opens a folder through the native dialog and starts the next session there", async () => {
    openDialog.mockResolvedValue("/Users/test/code/new-project");
    const invokeSpy = vi.spyOn(tauriInternals(), "invoke");
    await renderApp();

    await click(sidebar().getByRole("button", { name: "Open folder" }));
    expect(sidebar().getByText("new-project")).toBeDefined();
    await click(screen.getByRole("button", { name: "+ New session" }));
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "get started" } });
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Prompt" }), { key: "Enter" });
    });

    const args = invokeSpy.mock.calls.find(([cmd]) => cmd === "spawn_session")?.[1] as { cwd: string };
    expect(args.cwd).toBe("/Users/test/code/new-project");
  });

  it("reads a newly opened folder only once the backend has registered it", async () => {
    openDialog.mockResolvedValue("/Users/test/code/new-project");
    await renderApp();
    let finishRegistering: () => void = () => {};
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "remember_workspace"
        ? new Promise((resolve) => {
            finishRegistering = () => resolve(undefined);
          })
        : fakeTauriInvoke(cmd, args)
    );
    const detailsReads = () =>
      spy.mock.calls.filter(([cmd, a]) => cmd === "workspace_details" && (a as { path?: string })?.path === "/Users/test/code/new-project");

    await click(sidebar().getByRole("button", { name: "Open folder" }));
    expect(detailsReads()).toHaveLength(0);

    await act(async () => {
      finishRegistering();
    });
    await waitFor(() => expect(detailsReads()).toHaveLength(1));
  });

  it("opens settings, saves a new default agent, and can rerun setup", async () => {
    await renderApp();

    await click(screen.getByRole("button", { name: "More options" }));
    const dialog = within(screen.getByRole("dialog"));
    await act(async () => {
      fireEvent.change(dialog.getByLabelText("Default agent"), { target: { value: "omp" } });
    });
    await waitFor(() => expect(fakeStore().state.settings.defaultAgentId).toBe("omp"));

    await click(dialog.getByRole("button", { name: "Run setup again" }));
    expect(screen.getByRole("heading", { name: "Check your agents" })).toBeDefined();
  });
});
