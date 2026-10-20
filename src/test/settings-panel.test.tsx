import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { SettingsPanel } from "../components/SettingsPanel";
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
  onClose: () => void;
  initialTab?: "general" | "agents";
  agentsPanel: ReactNode;
  updateCount: number;
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
    agentsPanel: <p>The agent catalog</p>,
    updateCount: 0,
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

describe("SettingsPanel — tabs", () => {
  it("opens on General, with its sections and no catalog", () => {
    renderSettings();

    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "false");
    const panel = screen.getByRole("tabpanel", { name: "General" });
    expect(within(panel).getByRole("combobox", { name: "Appearance" })).toBeInTheDocument();
    expect(within(panel).getByRole("combobox", { name: "Default agent" })).toBeInTheDocument();
    expect(within(panel).getByRole("list", { name: "Recent folders" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Run setup again" })).toBeInTheDocument();
    expect(screen.queryByText("The agent catalog")).toBeNull();
  });

  it("switches to the catalog on a click", () => {
    renderSettings();

    fireEvent.click(screen.getByRole("tab", { name: "Agents" }));

    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("tabpanel", { name: "Agents" })).getByText("The agent catalog")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Appearance" })).toBeNull();
  });

  it("moves between the tabs with the arrow keys, wrapping around", () => {
    renderSettings();
    const general = screen.getByRole("tab", { name: "General" });
    const agents = screen.getByRole("tab", { name: "Agents" });

    fireEvent.keyDown(general, { key: "ArrowRight" });
    expect(agents).toHaveAttribute("aria-selected", "true");
    expect(agents).toHaveFocus();

    fireEvent.keyDown(agents, { key: "ArrowRight" });
    expect(general).toHaveAttribute("aria-selected", "true");
    expect(general).toHaveFocus();

    fireEvent.keyDown(general, { key: "ArrowLeft" });
    expect(agents).toHaveAttribute("aria-selected", "true");
  });

  it("keeps only the selected tab in the Tab order", () => {
    renderSettings();

    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute("tabindex", "-1");
  });

  it("opens on the catalog when asked", () => {
    renderSettings({ initialTab: "agents" });

    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("The agent catalog")).toBeInTheDocument();
  });

  it("counts the agents with updates on the Agents tab", () => {
    renderSettings({ updateCount: 2 });

    const tab = screen.getByRole("tab", { name: "Agents, 2 updates" });
    expect(tab).toHaveTextContent("2");
  });

  it("says one update in the singular", () => {
    renderSettings({ updateCount: 1 });

    expect(screen.getByRole("tab", { name: "Agents, 1 update" })).toBeInTheDocument();
  });

  it("no longer offers Check again in General", () => {
    renderSettings();

    expect(screen.queryByRole("button", { name: /Check again/ })).toBeNull();
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
