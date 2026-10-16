import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act, waitFor } from "@testing-library/react";
import { Onboarding } from "../components/Onboarding";
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

const CLAUDE_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";
const AIDER_INSTALL_COMMAND = "python -m pip install aider-install && aider-install";

/** Recent folders may carry persistence fields the component must not forward. */
type FolderFixture = { name: string; path: string; lastOpenedAt?: number };

const RECENT_FOLDERS: FolderFixture[] = [
  { name: "trading-bot", path: "/Users/test/trading-bot", lastOpenedAt: 1_699_000_000_000 },
  { name: "docs-site", path: "/Users/test/docs-site", lastOpenedAt: 1_698_000_000_000 },
];

const SUGGESTED_FOLDERS: FolderFixture[] = [{ name: "my-app", path: "/Users/test/my-app" }];

type OnboardingResult = { defaultAgentId: string; folder: { name: string; path: string } };

type OnboardingProps = {
  agents: AgentProfile[];
  recentFolders: FolderFixture[];
  suggestedFolders: FolderFixture[];
  onRecheckAgents: () => void | Promise<void>;
  onPickFolder: () => Promise<{ name: string; path: string } | null>;
  onComplete: (result: OnboardingResult) => void;
};

function notDetected(agent: AgentProfile): AgentProfile {
  return { ...agent, detected: false, detected_path: null };
}

let clipboardWriteText: ReturnType<typeof vi.fn>;

/** jsdom ships no navigator.clipboard, so each test gets a fresh stub. */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

function renderOnboarding(overrides: Partial<OnboardingProps> = {}): OnboardingProps {
  const props: OnboardingProps = {
    agents: AGENTS,
    recentFolders: RECENT_FOLDERS,
    suggestedFolders: SUGGESTED_FOLDERS,
    onRecheckAgents: vi.fn(),
    onPickFolder: vi.fn(async () => null),
    onComplete: vi.fn(),
    ...overrides,
  };
  render(<Onboarding {...props} />);
  return props;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

async function clickButton(name: string): Promise<void> {
  await click(screen.getByRole("button", { name }));
}

function stepItems(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Setup progress" })).getAllByRole("listitem");
}

function agentItem(agentName: string): HTMLElement {
  const item = within(screen.getByRole("list", { name: "Agents" }))
    .getAllByRole("listitem")
    .find((candidate) => candidate.textContent?.includes(agentName));
  if (!item) {
    throw new Error(`No agent list item for "${agentName}"`);
  }
  return item;
}

function folderButton(listLabel: string, namePattern: RegExp): HTMLElement {
  return within(screen.getByRole("list", { name: listLabel })).getByRole("button", {
    name: namePattern,
  });
}

async function selectRecentFolder(namePattern: RegExp = /trading-bot/): Promise<void> {
  await click(folderButton("Recent folders", namePattern));
}

async function goToFolderStep(): Promise<void> {
  await clickButton("Continue");
}

async function goToDefaultAgentStep(): Promise<void> {
  await goToFolderStep();
  await selectRecentFolder();
  await clickButton("Continue");
}

beforeEach(() => {
  vi.clearAllMocks();
  clipboardWriteText = stubClipboard();
});

describe("Onboarding — agent step", () => {
  it("shows the three setup steps with the agents step marked current", () => {
    renderOnboarding();

    const items = stepItems();

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Agents",
      "Folder",
      "Default agent",
    ]);
    expect(items[0]).toHaveAttribute("aria-current", "step");
    expect(items[1]).not.toHaveAttribute("aria-current");
    expect(items[2]).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("heading", { level: 2, name: "Check your agents" })
    ).toBeInTheDocument();
  });

  it("lists every agent with its readiness status and detected path", () => {
    renderOnboarding();

    const items = within(screen.getByRole("list", { name: "Agents" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);

    const claude = agentItem("Claude Code");
    expect(claude).toHaveTextContent("Ready");
    expect(claude).toHaveTextContent("/opt/homebrew/bin/claude");

    const aider = agentItem("Aider");
    expect(aider).toHaveTextContent("Ready");
    expect(aider).toHaveTextContent("/usr/local/bin/aider");

    const missing = agentItem("Oh-My-Pi");
    expect(missing).toHaveTextContent("Not installed");
  });

  it("blocks Continue and says why when no agent is installed", () => {
    renderOnboarding({
      agents: [notDetected(claudeCode), omp, notDetected(aider)],
    });

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(
      screen.getByText("Install at least one agent to continue.")
    ).toBeInTheDocument();
  });

  it("enables Continue once at least one agent is ready", () => {
    renderOnboarding();

    expect(screen.queryByText("Install at least one agent to continue.")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("offers a copyable install command for a missing agent", async () => {
    renderOnboarding({ agents: [notDetected(claudeCode), omp, aider] });

    const item = agentItem("Claude Code");
    expect(item).toHaveTextContent("Not installed");
    const command = within(item).getByText(CLAUDE_INSTALL_COMMAND);
    expect(command.closest("code")).not.toBeNull();

    await click(within(item).getByRole("button", {
      name: "Copy install command for Claude Code",
    }));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith(CLAUDE_INSTALL_COMMAND);
    });
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
  });

  it("offers the aider-install command when Aider is missing", () => {
    renderOnboarding({ agents: [claudeCode, omp, notDetected(aider)] });

    const item = agentItem("Aider");
    const command = within(item).getByText(AIDER_INSTALL_COMMAND);
    expect(command.closest("code")).not.toBeNull();
    expect(
      within(item).getByRole("button", { name: "Copy install command for Aider" })
    ).toBeInTheDocument();
  });

  it("points to the omp documentation instead of an install command", () => {
    renderOnboarding();

    const item = agentItem("Oh-My-Pi");

    expect(within(item).getByText(/See the omp documentation/)).toBeInTheDocument();
    expect(
      within(item).queryByRole("button", { name: /Copy install command/ })
    ).toBeNull();
  });

  it("re-runs agent detection when Check again is clicked", async () => {
    const onRecheckAgents = vi.fn().mockResolvedValue(undefined);
    renderOnboarding({ onRecheckAgents });

    await clickButton("Check again");

    expect(onRecheckAgents).toHaveBeenCalledTimes(1);
  });

  it("explains when re-running agent detection fails", async () => {
    const onRecheckAgents = vi.fn().mockRejectedValue(new Error("detection failed"));
    renderOnboarding({ onRecheckAgents });

    await clickButton("Check again");

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't check your agents.");
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  });
});

describe("Onboarding — folder step", () => {
  it("selects the folder returned by the native dialog", async () => {
    const onPickFolder = vi.fn(async () => ({
      name: "picked-app",
      path: "/Users/test/picked-app",
    }));
    renderOnboarding({ onPickFolder });
    await goToFolderStep();

    await clickButton("Open folder…");

    expect(onPickFolder).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/\/Users\/test\/picked-app/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("keeps Continue disabled when the folder dialog is cancelled", async () => {
    const onPickFolder = vi.fn(async () => null);
    renderOnboarding({ onPickFolder });
    await goToFolderStep();

    await clickButton("Open folder…");

    expect(onPickFolder).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("explains when the folder dialog fails to open", async () => {
    const onPickFolder = vi.fn().mockRejectedValue(new Error("dialog unavailable"));
    renderOnboarding({ onPickFolder });
    await goToFolderStep();

    await clickButton("Open folder…");

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't open the folder dialog.");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("selects a recent folder and enables Continue", async () => {
    renderOnboarding();
    await goToFolderStep();

    const tradingBot = folderButton("Recent folders", /trading-bot/);
    expect(tradingBot).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    await click(tradingBot);

    expect(tradingBot).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("selects a suggested folder and enables Continue", async () => {
    renderOnboarding();
    await goToFolderStep();

    const myApp = folderButton("Suggested folders", /my-app/);
    expect(myApp).toHaveAttribute("aria-pressed", "false");

    await click(myApp);

    expect(myApp).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("returns to the agents step when Back is clicked", async () => {
    renderOnboarding();
    await goToFolderStep();
    expect(
      screen.getByRole("heading", { level: 2, name: "Choose a project folder" })
    ).toBeInTheDocument();

    await clickButton("Back");

    expect(
      screen.getByRole("heading", { level: 2, name: "Check your agents" })
    ).toBeInTheDocument();
    expect(stepItems()[0]).toHaveAttribute("aria-current", "step");
  });
});

describe("Onboarding — default agent step", () => {
  it("offers only ready agents and preselects the first one", async () => {
    renderOnboarding();

    await goToDefaultAgentStep();

    expect(
      screen.getByRole("heading", { level: 2, name: "Pick a default agent" })
    ).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Default agent" });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(within(group).getByRole("radio", { name: /Claude Code/ })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /Aider/ })).not.toBeChecked();
    expect(within(group).queryByRole("radio", { name: /Oh-My-Pi/ })).toBeNull();
    expect(stepItems()[2]).toHaveAttribute("aria-current", "step");
  });

  it("reports the chosen agent and the selected folder when Start is clicked", async () => {
    const onComplete = vi.fn();
    const recentWithTimestamp: FolderFixture = {
      name: "trading-bot",
      path: "/Users/test/trading-bot",
      lastOpenedAt: 1_699_000_000_000,
    };
    renderOnboarding({
      recentFolders: [recentWithTimestamp],
      suggestedFolders: [],
      onComplete,
    });
    await goToFolderStep();
    await selectRecentFolder();
    await clickButton("Continue");

    const group = screen.getByRole("radiogroup", { name: "Default agent" });
    await click(within(group).getByRole("radio", { name: /Aider/ }));
    await clickButton("Start");

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      defaultAgentId: "aider",
      folder: { name: "trading-bot", path: "/Users/test/trading-bot" },
    });
  });

  it("returns to the folder step when Back is clicked", async () => {
    renderOnboarding();
    await goToDefaultAgentStep();

    await clickButton("Back");

    expect(
      screen.getByRole("heading", { level: 2, name: "Choose a project folder" })
    ).toBeInTheDocument();
    expect(stepItems()[1]).toHaveAttribute("aria-current", "step");
  });
});
