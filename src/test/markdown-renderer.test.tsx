import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { MarkdownRenderer } from "../components/MarkdownRenderer";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
const internals = () => (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;

describe("MarkdownRenderer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders GFM tables the agents answer with", () => {
    render(<MarkdownRenderer content={"| Test | Result |\n| --- | --- |\n| parser | pass |"} />);

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Result" })).toBeDefined();
    expect(within(table).getByRole("cell", { name: "pass" })).toBeDefined();
  });

  it("renders nested lists, quotes, emphasis and strikethrough", () => {
    render(<MarkdownRenderer content={"- top\n  - nested\n\n> quoted\n\n*soft* and ~~gone~~"} />);

    expect(screen.getAllByRole("list")).toHaveLength(2);
    expect(screen.getByText("quoted").closest("blockquote")).not.toBeNull();
    expect(screen.getByText("soft").tagName).toBe("EM");
    expect(screen.getByText("gone").tagName).toBe("DEL");
  });

  it("opens links in the browser instead of navigating the app away", () => {
    const spy = vi.spyOn(internals(), "invoke");
    render(<MarkdownRenderer content={"See [the docs](https://example.com/docs)."} />);

    fireEvent.click(screen.getByRole("link", { name: "the docs" }));

    expect(spy).toHaveBeenCalledWith("open_external_url", { url: "https://example.com/docs" }, undefined);
  });

  it("keeps the language label and Copy button on fenced code", () => {
    render(<MarkdownRenderer content={"```bash\npnpm test\n```"} />);

    expect(screen.getByText("bash")).toBeDefined();
    expect(screen.getByRole("button", { name: /copy code/i })).toBeDefined();
    expect(screen.getByText("pnpm test")).toBeDefined();
  });

  it("never renders raw HTML from an agent", () => {
    const { container } = render(<MarkdownRenderer content={'<img src=x onerror="alert(1)"> hi'} />);

    expect(container.querySelector("img")).toBeNull();
  });

  it("is memoized, so an unchanged message is not parsed again on every streamed chunk", () => {
    expect((MarkdownRenderer as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("shows a link the app cannot open (a file path) as plain text with its target, not a dead link", () => {
    const spy = vi.spyOn(internals(), "invoke");
    render(<MarkdownRenderer content={"Changed [App.tsx](src/App.tsx)."} />);

    expect(screen.queryByRole("link")).toBeNull();
    const text = screen.getByText("App.tsx");
    expect(text.getAttribute("title")).toBe("src/App.tsx");
    fireEvent.click(text);
    expect(spy.mock.calls.some(([cmd]) => cmd === "open_external_url")).toBe(false);
  });

  it("shows a remote image as a link to it, since the app does not load remote images", () => {
    const { container } = render(<MarkdownRenderer content={"![build status](https://example.com/badge.svg)"} />);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "Image: build status" }).getAttribute("href")).toBe(
      "https://example.com/badge.svg"
    );
  });
});

