import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";

describe("Button", () => {
  it("defaults to type button and does not submit a form", () => {
    const submit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    const { rerender } = render(
      <form onSubmit={submit}>
        <Button>Go</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(submit).not.toHaveBeenCalled();

    rerender(
      <form onSubmit={submit}>
        <Button type="submit">Go</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("variants use their tokens", () => {
    render(
      <>
        <Button variant="primary">P</Button>
        <Button variant="outline">O</Button>
        <Button variant="ghost">G</Button>
        <Button variant="danger">D</Button>
        <Button>Default</Button>
      </>,
    );
    const primary = screen.getByRole("button", { name: "P" });
    expect(primary).toHaveClass("bg-primary", "text-on-primary");
    expect(screen.getByRole("button", { name: "O" })).toHaveClass("border-border-strong");
    expect(screen.getByRole("button", { name: "G" })).toHaveClass("text-fg-muted");
    expect(screen.getByRole("button", { name: "D" })).toHaveClass(
      "bg-danger-surface",
      "text-danger",
    );
    expect(screen.getByRole("button", { name: "Default" })).toHaveClass("border-border-strong");
  });

  it("renders its icon before the label", () => {
    render(<Button icon={<svg data-testid="icon" />}>Label</Button>);
    const button = screen.getByRole("button", { name: "Label" });
    expect(button.firstElementChild).toBe(screen.getByTestId("icon"));
    expect(button.lastChild?.textContent).toBe("Label");
  });

  it("disabled Button does not fire onClick", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Off
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("appends className", () => {
    render(
      <Button variant="primary" className="ml-2">
        X
      </Button>,
    );
    expect(screen.getByRole("button", { name: "X" })).toHaveClass("ml-2", "bg-primary");
  });
});

describe("IconButton", () => {
  it("exposes its label", () => {
    render(
      <IconButton label="Close">
        <svg />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toHaveAttribute("title", "Close");
  });

  it("primary uses primary tokens, ghost uses muted", () => {
    render(
      <>
        <IconButton label="P" variant="primary">
          <svg />
        </IconButton>
        <IconButton label="G">
          <svg />
        </IconButton>
      </>,
    );
    expect(screen.getByRole("button", { name: "P" })).toHaveClass("bg-primary", "rounded-lg");
    expect(screen.getByRole("button", { name: "G" })).toHaveClass("rounded-md", "text-fg-muted");
  });
});
