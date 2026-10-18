import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { BackgroundTasksMenu, type BackgroundTasksMenuProps } from "../components/topbar/BackgroundTasksMenu";
import type { BackgroundTask } from "../lib/background-tasks";

const NOW = 1_700_000_000_000;

const devServer: BackgroundTask = {
  id: "process:41",
  kind: "process",
  name: "npm run dev",
  detail: "Fix login · localhost:5173",
  status: "Running",
  startedAt: NOW - 45_000,
  sessionId: "s1",
  pid: 41,
};

const agent: BackgroundTask = {
  id: "agent:s2",
  kind: "agent",
  name: "Refactor auth",
  status: "Needs approval",
  startedAt: NOW - 10_000,
  sessionId: "s2",
};

function setup(overrides: Partial<BackgroundTasksMenuProps> = {}) {
  const props: BackgroundTasksMenuProps = {
    tasks: [devServer, agent],
    isOpen: true,
    onOpenChange: vi.fn(),
    onOpenTask: vi.fn(),
    onStopTask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const view = render(<BackgroundTasksMenu {...props} />);
  return { props, ...view };
}

describe("BackgroundTasksMenu", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the trigger and badges the running count", () => {
    setup({ isOpen: false });
    expect(screen.getByRole("button", { name: "Background tasks (2 running)" })).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("uses the plain name when nothing runs", () => {
    setup({ isOpen: false, tasks: [] });
    expect(screen.getByRole("button", { name: "Background tasks" })).toBeTruthy();
  });

  it("asks to open when the trigger is clicked", () => {
    const { props } = setup({ isOpen: false });
    fireEvent.click(screen.getByRole("button", { name: /Background tasks/ }));
    expect(props.onOpenChange).toHaveBeenCalledWith(true);
  });

  it("lists each task with name, status, detail and duration", () => {
    setup();
    const rows = within(screen.getByRole("list", { name: "Running tasks" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("npm run dev")).toBeTruthy();
    expect(within(rows[0]).getByText("Running")).toBeTruthy();
    expect(within(rows[0]).getByText("Fix login · localhost:5173")).toBeTruthy();
    expect(within(rows[0]).getByText("45s")).toBeTruthy();
    expect(within(rows[1]).getByText("Needs approval")).toBeTruthy();
  });

  it("ticks the duration every second while open", () => {
    setup();
    expect(screen.getByText("45s")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("46s")).toBeTruthy();
  });

  it("runs no timer while closed", () => {
    setup({ isOpen: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens a task and closes the menu", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Open npm run dev" }));
    expect(props.onOpenTask).toHaveBeenCalledWith(devServer);
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows Stopping… until the task leaves the list", async () => {
    const { props, rerender } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Stop npm run dev" }));
    await act(async () => {});
    expect(props.onStopTask).toHaveBeenCalledWith(devServer);
    const stopping = screen.getByRole("button", { name: "Stop npm run dev" });
    expect(stopping.textContent).toContain("Stopping…");
    expect((stopping as HTMLButtonElement).disabled).toBe(true);

    rerender(<BackgroundTasksMenu {...props} tasks={[agent]} />);
    expect(screen.queryByRole("button", { name: "Stop npm run dev" })).toBeNull();

    rerender(<BackgroundTasksMenu {...props} tasks={[devServer, agent]} />);
    expect(screen.getByRole("button", { name: "Stop npm run dev" }).textContent).not.toContain("Stopping…");
  });

  it("says nothing is running when empty", () => {
    setup({ tasks: [] });
    expect(screen.getByText("Nothing running.")).toBeTruthy();
  });

  it("closes on Escape", () => {
    const { props } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});
