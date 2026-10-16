import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { TopBar } from "../components/TopBar";
import { Sidebar } from "../components/Sidebar";
import App from "../App";
import type { AgentProfile, Session } from "../types";
import { fakeProfiles } from "./fixtures/agents";

describe("Navigation and Layout Components", () => {
  const mockProfiles: AgentProfile[] = fakeProfiles;

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

      // Terminal toggle button
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
    const workspaces = [
      { name: "ai-perpetual-trading", path: "/Users/mac/ai-perpetual-trading" },
      { name: "titan-investment", path: "/Users/mac/titan-investment" },
    ];

    it("renders workspaces, sessions grouped by folder, agents, and the given footer", () => {
      const onNewSession = vi.fn();
      const onSelectSession = vi.fn();
      const onSelectWorkspace = vi.fn();

      render(
        <Sidebar
          workspaces={workspaces}
          activeWorkspacePath="/Users/mac/ai-perpetual-trading"
          sessions={mockSessions}
          activeSessionId="s-1"
          agents={mockProfiles}
          onNewSession={onNewSession}
          onSelectSession={onSelectSession}
          onSelectWorkspace={onSelectWorkspace}
          footer={<span>footer content</span>}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /\+ new/i }));
      expect(onNewSession).toHaveBeenCalledTimes(1);

      const workspaceList = within(screen.getByRole("list", { name: "Workspaces" }));
      fireEvent.click(workspaceList.getByText("titan-investment"));
      expect(onSelectWorkspace).toHaveBeenCalledWith("/Users/mac/titan-investment");

      const titanSessions = within(screen.getByRole("list", { name: "Sessions in titan-investment" }));
      fireEvent.click(titanSessions.getByText("Market analyzer refactor"));
      expect(onSelectSession).toHaveBeenCalledWith("s-2");

      expect(screen.getByText("Claude Code")).toBeDefined();
      expect(screen.getByText("Aider")).toBeDefined();
      expect(screen.getByText("footer content")).toBeDefined();
      expect(screen.queryByText(/iwang/i)).toBeNull();
    });

    it("filters sessions and workspaces when searching", () => {
      render(
        <Sidebar
          workspaces={workspaces}
          activeWorkspacePath="/Users/mac/ai-perpetual-trading"
          sessions={mockSessions}
          activeSessionId="s-1"
          agents={mockProfiles}
          onNewSession={() => {}}
          onSelectSession={() => {}}
          onSelectWorkspace={() => {}}
        />
      );

      fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "titan" } });

      const workspaceList = within(screen.getByRole("list", { name: "Workspaces" }));
      expect(workspaceList.getByText("titan-investment")).toBeDefined();
      expect(workspaceList.queryByText("ai-perpetual-trading")).toBeNull();
      expect(screen.queryByRole("list", { name: "Sessions in ai-perpetual-trading" })).toBeNull();
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
