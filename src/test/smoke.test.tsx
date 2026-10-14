import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import App from "../App";

describe("App smoke test", () => {
  it("renders header and initial workspace title", async () => {
    await act(async () => {
      render(<App />);
    });
    expect(screen.getAllByText("New session (fork)").length).toBeGreaterThan(0);
    expect(screen.getByText("Claude Code Session #1")).toBeDefined();
    expect(screen.getByText("agent-desktop")).toBeDefined();
    expect(screen.getByText("Codebase Inspection Summary")).toBeDefined();
  });
});

