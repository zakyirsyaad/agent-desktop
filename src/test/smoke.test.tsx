import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "../App";

describe("App smoke test", () => {
  it("renders header and initial workspace title", () => {
    render(<App />);
    expect(screen.getByText("Agent Desktop GUI")).toBeDefined();
    expect(screen.getByText("Claude Code Session #1")).toBeDefined();
    expect(screen.getByText("agent-desktop")).toBeDefined();
  });
});
