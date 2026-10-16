import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { TopBar } from "../components/TopBar";
import { Sidebar } from "../components/Sidebar";
import App from "../App";
import type { AgentProfile, Session } from "../types";

describe("Navigation and Layout Components", () => {
  const mockProfiles: AgentProfile[] = [
    {
      id: "claude-code",
      name: "Claude Code",
      command: "claude",
      detected: true,
      detected_path: "/opt/homebrew/bin/claude",
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      effort_levels: ["Low", "Medium", "High"],
    },
    {
      id: "omp",
      name: "Oh-My-Pi",
      command: "omp",
      detected: true,
      detected_path: "/usr/local/bin/omp",
      models: ["gemini-3.8-flash-tiered"],
      effort_levels: ["Low", "High"],
    },
    {
      id: "aider",
      name: "Aider",
      command: "aider",
      detected: false,
      models: ["gpt-5"],
      effort_levels: [],
    },
  ];

  const mockSessions: Session[] = [
    {
      id: "s-1",
      name: "New session (fork)",
      profileId: "claude-code",
      cwd: "/Users/mac/ai-perpetual-trading",
      status: "running",
      createdAt: Date.now() - 3600000,
    },
    {
      id: "s-2",
      name: "Market analyzer refactor",
      profileId: "omp",
      cwd: "/Users/mac/titan-investment",
      status: "idle",
      createdAt: Date.now() - 7200000,
    },
  ];

  describe("TopBar", () => {
    it("renders the session breadcrumb, workspace badge, and terminal toggle", () => {
      const onToggleTerminal = vi.fn();

      render(
        <TopBar
          sessionName="New session (fork)"
          workspaceName="ai-perpetual-trading"
          isTerminalOpen={false}
          onToggleTerminal={onToggleTerminal}
        />
      );

      // Breadcrumb elements
      expect(screen.getByText("New session (fork)")).toBeDefined();
      expect(screen.getByText("ai-perpetual-trading")).toBeDefined();

      // Terminal toggle button (>_)
      const terminalBtn = screen.getByRole("button", { name: /toggle terminal/i });
      expect(terminalBtn).toBeDefined();
      fireEvent.click(terminalBtn);
      expect(onToggleTerminal).toHaveBeenCalledTimes(1);
    });

    it("displays active terminal state badge/indicator when open", () => {
      render(
        <TopBar
          sessionName="Active Session"
          workspaceName="my-workspace"
          isTerminalOpen={true}
          onToggleTerminal={() => {}}
        />
      );

      const terminalBtn = screen.getByRole("button", { name: /toggle terminal/i });
      expect(terminalBtn.getAttribute("aria-pressed")).toBe("true");
    });
  });

  describe("Sidebar", () => {
    it("renders search input, + New session button, workspaces, sessions, agents, and profile footer", () => {
      const onNewSession = vi.fn();
      const onSelectSession = vi.fn();
      const onSelectWorkspace = vi.fn();

      render(
        <Sidebar
          workspaces={["ai-perpetual-trading", "titan-investment"]}
          activeWorkspace="ai-perpetual-trading"
          sessions={mockSessions}
          activeSessionId="s-1"
          agents={mockProfiles}
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
          onSelectWorkspace={onSelectWorkspace}
        />
      );

      // Search input and new session button
      expect(screen.getByPlaceholderText(/search/i)).toBeDefined();
      const newSessionBtn = screen.getByRole("button", { name: /\+ new/i });
      expect(newSessionBtn).toBeDefined();
      fireEvent.click(newSessionBtn);
      expect(onNewSession).toHaveBeenCalledTimes(1);

      // Workspaces list
      const wsItem = screen.getByText("ai-perpetual-trading");
      expect(wsItem).toBeDefined();
      fireEvent.click(screen.getByText("titan-investment"));
      expect(onSelectWorkspace).toHaveBeenCalledWith("titan-investment");

      // Sessions list
      expect(screen.getByText("New session (fork)")).toBeDefined();
      expect(screen.getByText("Market analyzer refactor")).toBeDefined();
      fireEvent.click(screen.getByText("Market analyzer refactor"));
      expect(onSelectSession).toHaveBeenCalledWith("s-2");

      // Detected agents with green indicators
      expect(screen.getByText("Claude Code")).toBeDefined();
      expect(screen.getByText("Oh-My-Pi")).toBeDefined();
      expect(screen.getByText("Aider")).toBeDefined();

      // Profile footer
      expect(screen.getByText(/pro/i)).toBeDefined();
      expect(screen.getByText(/iwang/i)).toBeDefined();
    });

    it("filters sessions and workspaces when searching", () => {
      render(
        <Sidebar
          workspaces={["ai-perpetual-trading", "titan-investment"]}
          activeWorkspace="ai-perpetual-trading"
          sessions={mockSessions}
          activeSessionId="s-1"
          agents={mockProfiles}
          onNewSession={() => {}}
          onSelectSession={() => {}}
          onSelectWorkspace={() => {}}
        />
      );

      const searchInput = screen.getByPlaceholderText(/search/i);
      fireEvent.change(searchInput, { target: { value: "titan" } });

      // titan-investment workspace should remain, ai-perpetual-trading filtered out
      expect(screen.getByText("titan-investment")).toBeDefined();
      expect(screen.queryByText("ai-perpetual-trading")).toBeNull();
    });
  });

  describe("App Integration", () => {
    it("renders TopBar and Sidebar inside App with functional terminal drawer toggle", async () => {
      await act(async () => {
        render(<App />);
      });

      expect(screen.getAllByText(/ai-perpetual-trading/i).length).toBeGreaterThan(0);
      expect(screen.getByPlaceholderText(/search/i)).toBeDefined();

      // Verify toggle button works in App
      const toggleBtn = screen.getByRole("button", { name: /toggle terminal/i });
      expect(toggleBtn).toBeDefined();
      await act(async () => {
        fireEvent.click(toggleBtn);
      });
      // Drawer or state reflected
      expect(toggleBtn.getAttribute("aria-pressed")).toBe("true");
    });
  });
});
