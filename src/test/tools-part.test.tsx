import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ToolsPart } from "../components/chat/ToolsPart";
import type { ToolExecution } from "../types";

const readTool: ToolExecution = {
  id: "t-1",
  name: "Read src/App.tsx",
  status: "completed",
  kind: "read",
  details: [{ kind: "text", text: "file contents" }],
};

const runTool: ToolExecution = {
  id: "t-2",
  name: "pnpm test",
  status: "failed",
  kind: "execute",
  details: [{ kind: "text", text: "1 failed" }],
};

describe("ToolsPart", () => {
  it("draws the whole group as one card with flat tool rows", () => {
    render(<ToolsPart tools={[readTool, runTool]} isCurrentTurn={false} />);

    const summary = screen.getByRole("button", { name: /Read a file, ran a command/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(summary);

    const card = summary.parentElement;
    expect(card).not.toBeNull();
    expect(card!.className).toContain("border");
    expect(card!.className).toContain("rounded-lg");

    // The card is the only full border; the divider is a top border.
    expect(card!.querySelectorAll(".border")).toHaveLength(0);

    const row = within(card!).getByRole("button", { name: /Read src\/App\.tsx/ });
    expect(card!.contains(row)).toBe(true);
    expect(row.className).not.toContain("border");
    expect(row.className).not.toContain("rounded");

    // The output stays out of the DOM until the row is opened.
    expect(within(card!).queryByText("file contents")).toBeNull();
    fireEvent.click(row);
    expect(within(card!).getByText("file contents")).toBeDefined();
  });

  it("shows quiet statuses on the tool rows", () => {
    render(<ToolsPart tools={[readTool, runTool]} isCurrentTurn={false} />);
    fireEvent.click(screen.getByRole("button", { name: /Read a file, ran a command/ }));

    const card = screen.getByRole("button", { name: /Read a file, ran a command/ }).parentElement!;
    const completed = within(card).getByText("Completed");
    expect(completed.className).toBe("sr-only");
    expect(within(card).getByText("Failed").className).toContain("text-danger");
  });
});
