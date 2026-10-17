import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ContextMeter } from "../components/composer/ContextMeter";

describe("ContextMeter details", () => {
  it("opens the context's details when clicked: used, window, share, what is left and the cost", () => {
    render(<ContextMeter used={250_000} size={1_000_000} cost={{ amount: 0.4231, currency: "USD" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Context details" }));

    const details = within(screen.getByRole("dialog", { name: "Context usage" }));
    expect(details.getByText("250,000 tokens")).toBeDefined();
    expect(details.getByText("1,000,000 tokens")).toBeDefined();
    expect(details.getByText("25%")).toBeDefined();
    expect(details.getByText("750,000 tokens")).toBeDefined();
    expect(details.getByText("$0.42")).toBeDefined();
  });

  it("leaves out what the agent does not report, and closes on a second click", () => {
    render(<ContextMeter used={12_000} size={0} />);
    const button = screen.getByRole("button", { name: "Context details" });

    fireEvent.click(button);
    const details = within(screen.getByRole("dialog", { name: "Context usage" }));
    expect(details.getByText("12,000 tokens")).toBeDefined();
    expect(details.queryByText(/left/i)).toBeNull();
    expect(details.queryByText(/cost/i)).toBeNull();

    fireEvent.click(button);
    expect(screen.queryByRole("dialog", { name: "Context usage" })).toBeNull();
  });
});
