import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  TopBar,
  TOP_BAR_TRAFFIC_LIGHT_INSET_PX,
  type TopBarProps,
} from "../components/TopBar";

/** Renders TopBar with the only required props filled in. */
function renderTopBar(overrides: Partial<TopBarProps> = {}) {
  const props: TopBarProps = {
    isTerminalOpen: false,
    onToggleTerminal: () => {},
    ...overrides,
  };
  return render(<TopBar {...props} />);
}

function headerOf(container: HTMLElement): HTMLElement {
  const header = container.querySelector("header");
  expect(header).not.toBeNull();
  return header as HTMLElement;
}

describe("TopBar", () => {
  describe("native macOS traffic lights", () => {
    it("renders no fake traffic-light controls", () => {
      const { container } = renderTopBar();

      expect(screen.queryByLabelText(/window controls/i)).toBeNull();
      // The three fake circles were painted with the macOS button colours.
      expect(container.innerHTML).not.toContain("ff5f56");
      expect(container.innerHTML).not.toContain("ffbd2e");
      expect(container.innerHTML).not.toContain("27c93f");
    });

    it("reserves the inset the real traffic lights float in", () => {
      const { container } = renderTopBar();

      expect(TOP_BAR_TRAFFIC_LIGHT_INSET_PX).toBe(78);
      expect(headerOf(container).style.paddingLeft).toBe(
        `${TOP_BAR_TRAFFIC_LIGHT_INSET_PX}px`
      );
    });

    it("marks the header and its inert areas as the window drag region", () => {
      const { container } = renderTopBar({
        sessionName: "Market analyzer refactor",
      });

      const header = headerOf(container);
      expect(header.hasAttribute("data-tauri-drag-region")).toBe(true);

      // Dragging only starts on the element that carries the attribute, so the
      // breadcrumb area needs it too; the buttons must not swallow drags into clicks.
      const dragRegions = Array.from(
        container.querySelectorAll("[data-tauri-drag-region]")
      );
      expect(dragRegions.length).toBeGreaterThan(1);
      expect(
        dragRegions.some((el) => el.textContent?.includes("Market analyzer refactor"))
      ).toBe(true);
      for (const region of dragRegions) {
        expect(region.closest("button")).toBeNull();
      }
    });
  });

  describe("back / forward between sessions", () => {
    it("disables both buttons when there is nowhere to go", () => {
      renderTopBar({ canGoBack: false, canGoForward: false });

      const back = screen.getByRole("button", { name: /back/i });
      const forward = screen.getByRole("button", { name: /forward/i });
      expect(back.hasAttribute("disabled")).toBe(true);
      expect(forward.hasAttribute("disabled")).toBe(true);
    });

    it("disables the buttons by default when no navigation props are given", () => {
      renderTopBar();

      expect(
        screen.getByRole("button", { name: /back/i }).hasAttribute("disabled")
      ).toBe(true);
      expect(
        screen.getByRole("button", { name: /forward/i }).hasAttribute("disabled")
      ).toBe(true);
    });

    it("enables and calls back when the history allows it", () => {
      const onBack = vi.fn();
      renderTopBar({ canGoBack: true, canGoForward: false, onBack });

      const back = screen.getByRole("button", { name: /back/i });
      expect(back.hasAttribute("disabled")).toBe(false);

      fireEvent.click(back);
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("enables and calls forward when the history allows it", () => {
      const onForward = vi.fn();
      renderTopBar({ canGoBack: false, canGoForward: true, onForward });

      const forward = screen.getByRole("button", { name: /forward/i });
      expect(forward.hasAttribute("disabled")).toBe(false);

      fireEvent.click(forward);
      expect(onForward).toHaveBeenCalledTimes(1);
    });

    it("does not fire the handler of a disabled button", () => {
      const onBack = vi.fn();
      const onForward = vi.fn();
      renderTopBar({ canGoBack: false, canGoForward: false, onBack, onForward });

      fireEvent.click(screen.getByRole("button", { name: /back/i }));
      fireEvent.click(screen.getByRole("button", { name: /forward/i }));

      expect(onBack).not.toHaveBeenCalled();
      expect(onForward).not.toHaveBeenCalled();
    });
  });

  describe("optional action buttons", () => {
    it("hides popout, folder and more-options when no handlers are given", () => {
      renderTopBar();

      expect(screen.queryByRole("button", { name: /popout/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /workspace directory/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /more options/i })).toBeNull();
    });

    it("shows and calls the popout button when onPopout is given", () => {
      const onPopout = vi.fn();
      renderTopBar({ onPopout });

      const popout = screen.getByRole("button", { name: /popout/i });
      fireEvent.click(popout);
      expect(onPopout).toHaveBeenCalledTimes(1);
    });

    it("shows the files toggle when onToggleFiles is given, pressed while the panel is open", () => {
      const onToggleFiles = vi.fn();
      renderTopBar({ onToggleFiles, isFilesOpen: true });

      const toggle = screen.getByRole("button", { name: "Toggle files panel" });
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(toggle);
      expect(onToggleFiles).toHaveBeenCalledTimes(1);
    });

    it("shows and calls more options when onOpenSettings is given", () => {
      const onOpenSettings = vi.fn();
      renderTopBar({ onOpenSettings });

      fireEvent.click(screen.getByRole("button", { name: /more options/i }));
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
    });

    it("keeps the terminal toggle regardless of the optional handlers", () => {
      const onToggleTerminal = vi.fn();
      renderTopBar({ isTerminalOpen: true, onToggleTerminal });

      const terminal = screen.getByRole("button", {
        name: /toggle terminal/i,
      });
      expect(terminal.getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(terminal);
      expect(onToggleTerminal).toHaveBeenCalledTimes(1);
    });
  });

  describe("breadcrumb", () => {
    it("still renders the session name and workspace badge", () => {
      renderTopBar({
        sessionName: "Market analyzer refactor",
        workspaceName: "titan-investment",
      });

      expect(screen.getByText("Market analyzer refactor")).toBeDefined();
      expect(screen.getByText("titan-investment")).toBeDefined();
    });
  });

  describe("title", () => {
    it("shows no made-up session or folder name when there is none", () => {
      render(<TopBar isTerminalOpen={false} onToggleTerminal={() => {}} />);

      expect(screen.queryByText(/new session \(fork\)/i)).toBeNull();
      expect(screen.queryByText("ai-perpetual-trading")).toBeNull();
      expect(screen.getByText("Zorvo")).toBeDefined();
    });

    it("shows only the folder when no session is open", () => {
      render(<TopBar workspaceName="api" isTerminalOpen={false} onToggleTerminal={() => {}} />);

      expect(screen.getByText("api")).toBeDefined();
      expect(screen.queryByText("/")).toBeNull();
    });
  });

  describe("terminal toggle", () => {
    it("shows the terminal icon once, without a duplicate >_ text glyph", () => {
      renderTopBar();

      const toggle = screen.getByRole("button", { name: "Toggle terminal drawer" });

      expect(toggle.textContent).not.toContain(">_");
      expect(toggle.querySelectorAll("svg")).toHaveLength(1);
    });
  });
});
