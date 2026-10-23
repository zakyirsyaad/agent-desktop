import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { TopBar } from "../components/TopBar";
import type { PlanEntry } from "../types";

const PLAN: PlanEntry[] = [
  { content: "Read the parser", status: "completed" },
  { content: "Split it in two", status: "in_progress" },
  { content: "Run the tests", status: "pending" },
];

describe("the plan in the top bar", () => {
  it("shows how many steps are done and lists every step in a popover", () => {
    render(<TopBar plan={PLAN} />);

    const button = screen.getByRole("button", { name: "Plan (1 of 3 done)" });
    expect(button.textContent).toContain("1/3");

    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Plan" });
    const list = within(dialog).getByRole("list", { name: "Plan" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("Split it in two")).toBeDefined();
  });

  it("stays hidden when the session has no plan", () => {
    render(<TopBar />);

    expect(screen.queryByRole("button", { name: /^Plan/ })).toBeNull();
  });

  it("follows a new plan", () => {
    const { rerender } = render(<TopBar plan={PLAN} />);

    rerender(
      <TopBar
        plan={[
          { content: "Read the parser", status: "completed" },
          { content: "Split it in two", status: "completed" },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "Plan (2 of 2 done)" })).toBeDefined();
  });
});