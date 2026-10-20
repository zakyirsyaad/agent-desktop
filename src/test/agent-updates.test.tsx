import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { FakeTauriStore } from "./setup";
import { makeCatalogAgent } from "./fixtures/catalog";
import type { AgentCatalog, Settings } from "../types";

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import App from "../App";
import { ProfileFooter } from "../components/ProfileFooter";
import { UpdateNotice } from "../components/UpdateNotice";
import { useAgentUpdates } from "../hooks/useAgentUpdates";
import { usePersistedState } from "../hooks/usePersistedState";

const fakeStore = () => (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
const savedSettings = () => fakeStore().state.settings as unknown as Settings;

afterEach(() => vi.restoreAllMocks());

const claude = (updateVersion: string | null) =>
  makeCatalogAgent({ id: "claude-acp", name: "Claude Code", version: "1.2.0", updateVersion, status: "by_zorvo" });
const codex = (updateVersion: string | null) =>
  makeCatalogAgent({ id: "codex-acp", name: "Codex", version: "0.9.0", updateVersion, status: "by_zorvo" });
const catalogOf = (...agents: ReturnType<typeof claude>[]): AgentCatalog => ({ lastChecked: 1, agents });

describe("UpdateNotice", () => {
  it("names the agent and version for one update", () => {
    render(<UpdateNotice agents={[{ ...claude("1.1.0") }]} onShow={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("Claude Code 1.1.0 is available.")).toBeInTheDocument();
  });

  it("counts the updates for several", () => {
    render(<UpdateNotice agents={[claude("1.1.0"), codex("1.0.0")]} onShow={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText("2 agent updates are available.")).toBeInTheDocument();
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<UpdateNotice agents={[]} onShow={() => {}} onDismiss={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("calls Show and Dismiss", () => {
    const onShow = vi.fn();
    const onDismiss = vi.fn();
    render(<UpdateNotice agents={[claude("1.1.0")]} onShow={onShow} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("ProfileFooter - update badge", () => {
  it("labels the Settings button with the count and shows a dot", () => {
    render(<ProfileFooter onOpenSettings={() => {}} updateCount={2} />);
    const button = screen.getByRole("button", { name: "Settings, 2 updates" });
    expect(button.querySelector(".bg-primary")).not.toBeNull();
  });

  it("uses the singular for one update", () => {
    render(<ProfileFooter onOpenSettings={() => {}} updateCount={1} />);
    expect(screen.getByRole("button", { name: "Settings, 1 update" })).toBeInTheDocument();
  });

  it("shows no dot and a plain label at zero", () => {
    render(<ProfileFooter onOpenSettings={() => {}} updateCount={0} />);
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button.querySelector(".bg-primary")).toBeNull();
  });
});

describe("useAgentUpdates", () => {
  function setup(initial: AgentCatalog | null) {
    return renderHook(
      ({ catalog }) => {
        const persisted = usePersistedState(() => {});
        const updates = useAgentUpdates({ catalog, settings: persisted.state.settings, updateState: persisted.updateState });
        return { ...updates, persisted };
      },
      { initialProps: { catalog: initial } },
    );
  }

  it("counts the pending updates of agents in use and lists the unnotified ones", async () => {
    const { result } = setup(catalogOf(claude("1.1.0"), codex(null)));
    await waitFor(() => expect(result.current.persisted.isLoaded).toBe(true));
    expect(result.current.updateCount).toBe(1);
    expect(result.current.unnotified.map((agent) => agent.id)).toEqual(["claude-acp"]);
  });

  it("stays quiet for that version after acknowledge, keeps the badge, and speaks again for a newer one", async () => {
    const { result, rerender } = setup(catalogOf(claude("1.1.0")));
    await waitFor(() => expect(result.current.persisted.isLoaded).toBe(true));

    act(() => result.current.acknowledge());

    expect(result.current.unnotified).toEqual([]);
    expect(result.current.updateCount).toBe(1);
    expect(result.current.persisted.state.settings.notifiedUpdates).toEqual({ "claude-acp": "1.1.0" });

    rerender({ catalog: catalogOf(claude("1.2.0")) });
    expect(result.current.unnotified.map((agent) => agent.updateVersion)).toEqual(["1.2.0"]);
  });
});

describe("App - update notice", () => {
  it("shows the badge and notice, Show opens Settings on Agents and the notice stays gone", async () => {
    await act(async () => {
      render(<App />);
    });
    expect(await screen.findByText("Claude Code 1.3.0 is available.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings, 1 update" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show" }));
    });

    expect(screen.getByRole("tab", { name: /Agents/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Claude Code 1.3.0 is available.")).toBeNull();
    await waitFor(() => expect(savedSettings().notifiedUpdates).toEqual({ "claude-acp": "1.3.0" }));
  });

  it("Dismiss records the version without opening Settings", async () => {
    await act(async () => {
      render(<App />);
    });
    await screen.findByText("Claude Code 1.3.0 is available.");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });

    expect(screen.queryByText("Claude Code 1.3.0 is available.")).toBeNull();
    expect(screen.queryByRole("tab", { name: /Agents/ })).toBeNull();
    await waitFor(() => expect(savedSettings().notifiedUpdates).toEqual({ "claude-acp": "1.3.0" }));
  });
});
