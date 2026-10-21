import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentSessionList } from "../components/workspace/AgentSessionList";
import type { SessionListState } from "../hooks/useAgentSessionList";
import type { ListedSession } from "../lib/session-list";

const AGENT = "Claude Code";

function renderList(state: SessionListState, importError: string | null = null) {
  const onLoad = vi.fn();
  const onImport = vi.fn();
  const view = render(
    <AgentSessionList agentName={AGENT} state={state} importError={importError} onLoad={onLoad} onImport={onImport} />,
  );
  const show = (next: SessionListState) =>
    view.rerender(
      <AgentSessionList agentName={AGENT} state={next} importError={importError} onLoad={onLoad} onImport={onImport} />,
    );
  return { ...view, onLoad, onImport, show };
}

const loaded = (sessions: ListedSession[], truncated = false, incomplete = false): SessionListState => ({
  kind: "loaded",
  sessions,
  truncated,
  incomplete,
});

describe("AgentSessionList", () => {
  it("offers to continue one of the agent's sessions from idle", () => {
    const { onLoad } = renderList({ kind: "idle" });

    fireEvent.click(screen.getByRole("button", { name: "Continue a session from Claude Code" }));

    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("says which agent it is asking while the list loads", () => {
    renderList({ kind: "loading" });

    expect(screen.getByText("Asking Claude Code for its sessions…")).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says when the agent has no other sessions in the folder", () => {
    renderList(loaded([]));

    expect(screen.getByText("Claude Code has no other sessions in this folder.")).toBeDefined();
  });

  it("shows each session's title and relative time, and imports the one clicked", () => {
    const sessions: ListedSession[] = [
      { acpSessionId: "a", title: "Fix the login", updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
      { acpSessionId: "b" },
      { acpSessionId: "c", title: "Bad date", updatedAt: "not a date" },
    ];
    const { onImport } = renderList(loaded(sessions));

    const dated = screen.getByRole("button", { name: /Fix the login/ });
    expect(dated.textContent).toContain("2 hours ago");
    fireEvent.click(dated);
    expect(onImport).toHaveBeenCalledWith(sessions[0]);

    const untitled = screen.getByRole("button", { name: "Untitled session" });
    expect(untitled.textContent).not.toContain("ago");
    fireEvent.click(untitled);
    expect(onImport).toHaveBeenLastCalledWith(sessions[1]);

    expect(screen.getByRole("button", { name: "Bad date" }).textContent).toBe("Bad date");
  });

  it("says when the list was cut short, and when some sessions could not be listed", () => {
    const { show } = renderList(loaded([], true, false));

    expect(screen.getByText("Showing the 200 most recent sessions.")).toBeDefined();
    expect(screen.queryByText("Some sessions could not be listed.")).toBeNull();

    show(loaded([], false, true));

    expect(screen.queryByText("Showing the 200 most recent sessions.")).toBeNull();
    expect(screen.getByText("Some sessions could not be listed.")).toBeDefined();
  });

  it("shows the error and tries again", () => {
    const { onLoad } = renderList({ kind: "failed", message: "The agent did not answer." });

    expect(screen.getByText("The agent did not answer.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("shows an import error beside the list", () => {
    renderList({ kind: "idle" }, "Import failed: the session no longer exists.");

    expect(screen.getByRole("alert").textContent).toContain("Import failed: the session no longer exists.");
  });

  it("gives every button the focus ring", () => {
    const { show } = renderList(loaded([{ acpSessionId: "a", title: "A" }]));

    for (const button of screen.getAllByRole("button")) expect(button).toHaveClass("focus-ring");

    show({ kind: "failed", message: "Nope" });
    for (const button of screen.getAllByRole("button")) expect(button).toHaveClass("focus-ring");

    show({ kind: "idle" });
    for (const button of screen.getAllByRole("button")) expect(button).toHaveClass("focus-ring");
  });
});