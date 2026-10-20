import { describe, it, expect } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import App from "../App";

describe("App smoke test", () => {
  it("starts without any mock content and shows the empty state and detected agents", async () => {
    await act(async () => {
      render(<App />);
    });

    expect(screen.queryByText("Codebase Inspection Summary")).toBeNull();
    expect(screen.queryByText("Market analyzer refactor")).toBeNull();
    expect(screen.getByRole("heading", { name: "New session" })).toBeDefined();
    const agents = within(screen.getByRole("list", { name: "Detected agents" }));
    expect(agents.getByText("Claude Code")).toBeDefined();
    expect(agents.getByText("Qwen Code")).toBeDefined();
  });
});
