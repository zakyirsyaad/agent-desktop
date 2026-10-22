import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SessionTree, type SessionListContext } from "../components/sidebar/SessionList";
import type { Session } from "../types";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s-1",
    name: "A session",
    profileId: "qwen",
    cwd: "/Users/test/developer/zorvo",
    status: "terminated",
    createdAt: 1,
    transport: "acp",
    ...overrides,
  };
}

function context(overrides: Partial<SessionListContext> = {}): SessionListContext {
  return {
    agentNameOf: () => "Qwen Code",
    isSessionBusy: () => false,
    isSessionWaiting: () => false,
    onSelectSession: vi.fn(),
    onRenameSession: vi.fn(),
    ...overrides,
  };
}

function renderRow(target: Session, overrides: Partial<SessionListContext> = {}) {
  render(
    <SessionTree
      nodes={[{ session: target, children: [] }]}
      label="Sessions"
      context={context(overrides)}
    />,
  );
  return screen.getByTestId(`session-row-${target.id}`);
}

describe("SessionRow trailing slot", () => {
  it("puts the busy dot and the row actions in one slot at the row's edge", () => {
    const busy = session({ id: "s-busy", status: "running" });
    const row = renderRow(busy, { isSessionBusy: () => true, onStopSession: vi.fn() });

    const trailing = within(row).getByTestId("session-row-trailing");
    const dot = within(trailing).getByLabelText("Agent working");
    expect(dot.className).toContain("pointer-events-none");
    expect(within(trailing).getByRole("button", { name: "Stop session" })).toBeDefined();
    expect(within(trailing).getByRole("button", { name: `More actions for ${busy.name}` })).toBeDefined();

    // The dot left the select button: its width no longer depends on the actions beside it.
    const select = within(row).getByText(busy.name).closest("button");
    expect(select).not.toBeNull();
    expect(select?.contains(dot)).toBe(false);
    expect(select?.title).toContain("The agent is working");
  });

  it("keeps the unread dot in the same slot as the row actions", () => {
    const unread = session({ id: "s-unread", hasUnread: true });
    const row = renderRow(unread, { onDeleteSession: vi.fn() });

    const trailing = within(row).getByTestId("session-row-trailing");
    expect(within(trailing).getByLabelText("New activity")).toBeDefined();
    expect(within(trailing).getByRole("button", { name: "Delete session" })).toBeDefined();
    expect(within(trailing).getByRole("button", { name: `More actions for ${unread.name}` })).toBeDefined();
  });

  it("uses the same slot on a row with no dot", () => {
    const idle = session({ id: "s-idle" });
    const row = renderRow(idle, { onDeleteSession: vi.fn() });

    const trailing = within(row).getByTestId("session-row-trailing");
    expect(within(trailing).queryByRole("status")).toBeNull();
    expect(within(trailing).getByRole("button", { name: "Delete session" })).toBeDefined();
  });
});
