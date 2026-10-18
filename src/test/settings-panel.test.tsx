import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import { SettingsPanel } from "../components/SettingsPanel";
import { RECHECK_ERROR } from "../lib/agent-readiness";
import type { Appearance } from "../lib/appearance";
import type { AgentProfile } from "../types";
import { makeProfile } from "./fixtures/agents";

const claudeCode: AgentProfile = makeProfile({
  id: "claude-code",
  name: "Claude Code",
  command: "claude",
  detected: true,
  detected_path: "/opt/homebrew/bin/claude",
  models: ["claude-sonnet-5-5"],
});

const omp: AgentProfile = makeProfile({
  id: "omp",
  name: "Oh-My-Pi",
  command: "omp",
  detected: false,
  models: [],
});

const aider: AgentProfile = makeProfile({
  id: "aider",
  name: "Aider",
  command: "aider",
  detected: true,
  detected_path: "/usr/local/bin/aider",
  models: ["gpt-5"],
});

const AGENTS = [claudeCode, omp, aider];

const RECENT_FOLDERS = [
  { name: "trading-bot", path: "/Users/test/trading-bot" },
  { name: "docs-site", path: "/Users/test/docs-site" },
];

type SettingsPanelProps = {
  appearance: Appearance;
  onChangeAppearance: (appearance: Appearance) => void;
  agents: AgentProfile[];
  defaultAgentId: string | null;
  recentFolders: { name: string; path: string }[];
  onChangeDefaultAgent: (id: string) => void;
  onRemoveRecentFolder: (path: string) => void;
  onRunOnboarding: () => void;
  onRecheckAgents?: () => Promise<void>;
  onClose: () => void;
};

function renderSettings(overrides: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  const props: SettingsPanelProps = {
    appearance: "system",
    onChangeAppearance: vi.fn(),
    agents: AGENTS,
    defaultAgentId: "claude-code",
    recentFolders: RECENT_FOLDERS,
    onChangeDefaultAgent: vi.fn(),
    onRemoveRecentFolder: vi.fn(),
    onRunOnboarding: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<SettingsPanel {...props} />);
  return props;
}

function defaultAgentSelect(): HTMLElement {
  return screen.getByRole("combobox", { name: "Default agent" });
}

describe("SettingsPanel — dialog", () => {
  it("renders a modal dialog named Settings", () => {
    renderSettings();

    const dialog = screen.getByRole("dialog", { name: "Settings" });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      screen.getByRole("heading", { level: 2, name: "Settings" })
    ).toBeInTheDocument();
  });

  it("moves keyboard focus into the dialog when it opens", () => {
    renderSettings();

    expect(screen.getByRole("button", { name: "Close settings" })).toHaveFocus();
  });

  it("closes when Close settings is clicked", () => {
    const onClose = vi.fn();
    renderSettings({ onClose });

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when Escape is pressed", () => {
    const onClose = vi.fn();
    renderSettings({ onClose });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open for keys other than Escape", () => {
    const onClose = vi.fn();
    renderSettings({ onClose });

    fireEvent.keyDown(document, { key: "Enter" });

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("SettingsPanel — default agent", () => {
  it("offers only ready agents and reflects the current default", () => {
    renderSettings({ defaultAgentId: "aider" });

    const select = defaultAgentSelect();

    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Claude Code",
      "Aider",
    ]);
    expect(within(select).queryByRole("option", { name: /Oh-My-Pi/ })).toBeNull();
    expect(select).toHaveValue("aider");
  });

  it("reports the newly chosen default agent", () => {
    const onChangeDefaultAgent = vi.fn();
    renderSettings({ defaultAgentId: "claude-code", onChangeDefaultAgent });

    fireEvent.change(defaultAgentSelect(), { target: { value: "aider" } });

    expect(onChangeDefaultAgent).toHaveBeenCalledTimes(1);
    expect(onChangeDefaultAgent).toHaveBeenCalledWith("aider");
  });
});

describe("SettingsPanel — recent folders", () => {
  it("lists each recent folder with its path and a remove action", () => {
    const onRemoveRecentFolder = vi.fn();
    renderSettings({ onRemoveRecentFolder });

    const items = within(screen.getByRole("list", { name: "Recent folders" })).getAllByRole(
      "listitem"
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("trading-bot");
    expect(items[0]).toHaveTextContent("/Users/test/trading-bot");

    fireEvent.click(
      within(items[0]).getByRole("button", {
        name: "Remove trading-bot from recent folders",
      })
    );

    expect(onRemoveRecentFolder).toHaveBeenCalledTimes(1);
    expect(onRemoveRecentFolder).toHaveBeenCalledWith("/Users/test/trading-bot");
  });

  it("shows an empty state when there are no recent folders", () => {
    renderSettings({ recentFolders: [] });

    expect(screen.getByText("No recent folders yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /from recent folders/ })).toBeNull();
  });
});

describe("SettingsPanel — setup", () => {
  it("runs onboarding again when asked", () => {
    const onRunOnboarding = vi.fn();
    renderSettings({ onRunOnboarding });

    fireEvent.click(screen.getByRole("button", { name: "Run setup again" }));

    expect(onRunOnboarding).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsPanel — agents", () => {
  it("checks for agents again, an install made while the app runs included", async () => {
    let finish: () => void = () => {};
    const onRecheckAgents = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderSettings({ onRecheckAgents });

    fireEvent.click(screen.getByRole("button", { name: "Check again for installed agents" }));

    expect(onRecheckAgents).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Check again for installed agents" })).toBeDisabled();
    await act(async () => finish());
    expect(screen.getByRole("button", { name: "Check again for installed agents" })).toBeEnabled();
  });

  it("offers the check after the default agent field, not inside it", () => {
    renderSettings({ onRecheckAgents: () => Promise.resolve() });

    const field = defaultAgentSelect();
    const check = screen.getByRole("button", { name: "Check again for installed agents" });
    expect(check.textContent).toContain("Check again");
    expect(field.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says in the dialog when a check failed, and stays usable", async () => {
    renderSettings({ onRecheckAgents: () => Promise.reject(new Error("no shell")) });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check again for installed agents" }));
    });

    expect(screen.getByRole("alert")).toHaveTextContent(RECHECK_ERROR);
    expect(screen.getByRole("button", { name: "Check again for installed agents" })).toBeEnabled();
  });
});


describe("SettingsPanel — appearance", () => {
  it("lists System, Light and Dark and shows the current value", () => {
    renderSettings({ appearance: "dark" });

    const select = screen.getByRole("combobox", { name: "Appearance" });

    expect(select).toHaveValue("dark");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["System", "Light", "Dark"]);
  });

  it("reports the chosen appearance", () => {
    const props = renderSettings();

    fireEvent.change(screen.getByRole("combobox", { name: "Appearance" }), { target: { value: "light" } });

    expect(props.onChangeAppearance).toHaveBeenCalledWith("light");
  });
});
