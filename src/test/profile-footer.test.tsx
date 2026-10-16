import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProfileFooter } from "../components/ProfileFooter";

describe("ProfileFooter", () => {
  describe("avatar initials", () => {
    it("derives up to two initials from the profile name", () => {
      render(<ProfileFooter name="Iwang Nurhadi" />);

      expect(screen.getByText("IN")).toBeDefined();
    });

    it("uses a single initial for a one-word name", () => {
      render(<ProfileFooter name="iwang" />);

      expect(screen.getByText("I")).toBeDefined();
    });

    it("ignores extra words beyond the first two", () => {
      render(<ProfileFooter name="Iwang Nurhadi Pratama" />);

      expect(screen.getByText("IN")).toBeDefined();
    });

    it("falls back to the first letter of the email when there is no name", () => {
      render(<ProfileFooter email="iwang@example.com" />);

      expect(screen.getByText("I")).toBeDefined();
    });

    it("falls back to a neutral person icon when neither name nor email is known", () => {
      render(<ProfileFooter />);

      const avatar = screen.getByRole("img", { name: /local user avatar/i });
      expect(avatar.querySelector("svg")).not.toBeNull();
      expect(avatar.textContent).toBe("");
    });
  });

  describe("display name", () => {
    it("shows the profile name", () => {
      render(<ProfileFooter name="Iwang Nurhadi" email="iwang@example.com" />);

      expect(screen.getByText("Iwang Nurhadi")).toBeDefined();
    });

    it("falls back to the email when there is no name", () => {
      render(<ProfileFooter email="iwang@example.com" />);

      expect(screen.getByText("iwang@example.com")).toBeDefined();
    });

    it("falls back to a neutral label when nothing is known", () => {
      render(<ProfileFooter />);

      expect(screen.getByText("Local user")).toBeDefined();
    });

    it("treats a whitespace-only name as missing", () => {
      render(<ProfileFooter name="   " email="iwang@example.com" />);

      expect(screen.getByText("iwang@example.com")).toBeDefined();
    });
  });

  describe("version line", () => {
    it("shows the app name and version when a version is given", () => {
      render(<ProfileFooter name="Iwang" version="0.1.0" />);

      expect(screen.getByText("Agent Desktop v0.1.0")).toBeDefined();
    });

    it("omits the version line when no version is known", () => {
      render(<ProfileFooter name="Iwang" />);

      expect(screen.queryByText(/Agent Desktop v/)).toBeNull();
    });
  });

  describe("no invented account state", () => {
    it("renders no plan or tier badge", () => {
      render(<ProfileFooter name="Iwang Nurhadi" email="iwang@example.com" version="0.1.0" />);

      expect(screen.queryByText("Pro")).toBeNull();
      expect(screen.queryByText(/pro\b/i)).toBeNull();
    });
  });

  describe("settings button", () => {
    it("calls onOpenSettings when clicked", () => {
      const onOpenSettings = vi.fn();
      render(<ProfileFooter name="Iwang" onOpenSettings={onOpenSettings} />);

      fireEvent.click(screen.getByRole("button", { name: /settings/i }));

      expect(onOpenSettings).toHaveBeenCalledTimes(1);
    });

    it("is hidden when no handler is given", () => {
      render(<ProfileFooter name="Iwang" />);

      expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
    });
  });
});
