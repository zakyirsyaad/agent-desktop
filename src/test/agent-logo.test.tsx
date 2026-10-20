import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { AgentLogo } from "../components/AgentLogo";
import { fakeTauriInvoke } from "./setup";

type Listener = (event: { payload: unknown }) => void;

const { listeners } = vi.hoisted(() => ({ listeners: new Map<string, Listener>() }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => {
      listeners.delete(event);
    });
  },
}));

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
const internals = () => (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;

const GEMINI_ICON = "data:image/svg+xml;base64,PHN2Zz4=";

/** Makes `get_agent_icons` answer with `icons`; other commands fall through to the fake backend. */
function answerIconsWith(icons: () => Record<string, string>) {
  return vi.spyOn(internals(), "invoke").mockImplementation((cmd, args) =>
    cmd === "get_agent_icons" ? Promise.resolve(icons()) : fakeTauriInvoke(cmd, args),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  listeners.clear();
});

describe("AgentLogo", () => {
  it("uses the bundled logo for claude-acp", async () => {
    answerIconsWith(() => ({ "claude-acp": GEMINI_ICON }));
    render(<AgentLogo profileId="claude-acp" name="Claude Code" />);
    await act(async () => {});

    expect(screen.getByRole("img", { name: "Claude Code" }).tagName).toBe("IMG");
  });

  it("renders a registry icon as a mask filled by a token", async () => {
    answerIconsWith(() => ({ gemini: GEMINI_ICON }));
    render(<AgentLogo profileId="gemini" name="Gemini CLI" size={16} />);
    await act(async () => {});

    const logo = screen.getByRole("img", { name: "Gemini CLI" });
    expect(logo.tagName).toBe("SPAN");
    expect(logo.classList.contains("bg-fg-muted")).toBe(true);
    expect(logo.style.maskImage).toContain(GEMINI_ICON);
    expect(logo.style.width).toBe("16px");
  });

  it("hides a registry icon from screen readers when the name is written next to it", async () => {
    answerIconsWith(() => ({ gemini: GEMINI_ICON }));
    const { container } = render(<AgentLogo profileId="gemini" name="" />);
    await act(async () => {});

    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector('span[aria-hidden="true"]')).not.toBeNull();
  });

  it("falls back to the generic icon", async () => {
    answerIconsWith(() => ({}));
    const { container } = render(<AgentLogo profileId="unknown-agent" name="Unknown" />);
    await act(async () => {});

    const logo = screen.getByRole("img", { name: "Unknown" });
    expect(logo.classList.contains("text-fg-muted")).toBe(true);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("reloads icons on agent-profiles-changed", async () => {
    let icons: Record<string, string> = {};
    answerIconsWith(() => icons);
    render(<AgentLogo profileId="gemini" name="Gemini CLI" />);
    await act(async () => {});
    expect(screen.getByRole("img", { name: "Gemini CLI" }).tagName.toLowerCase()).toBe("svg");

    icons = { gemini: GEMINI_ICON };
    await act(async () => {
      listeners.get("agent-profiles-changed")?.({ payload: null });
    });
    await act(async () => {});

    expect(screen.getByRole("img", { name: "Gemini CLI" }).tagName).toBe("SPAN");
  });
});
