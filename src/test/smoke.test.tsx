import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import App from "../App";

describe("App smoke test", () => {
  it("starts without any mock content and shows the empty state and detected agents", async () => {
    await act(async () => {
      render(<App />);
    });

    expect(screen.queryByText("Codebase Inspection Summary")).toBeNull();
    expect(screen.queryByText("Market analyzer refactor")).toBeNull();
    expect(screen.getByRole("heading", { name: "No session yet" })).toBeDefined();
    expect(screen.getByText("Claude Code")).toBeDefined();
    expect(screen.getByText("Oh-My-Pi")).toBeDefined();
  });
});
