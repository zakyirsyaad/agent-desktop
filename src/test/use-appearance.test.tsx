import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Appearance } from "../lib/appearance";

const setTheme = vi.fn();
vi.mock("@tauri-apps/api/app", () => ({ setTheme: (theme: unknown) => setTheme(theme) }));

import { useAppearance } from "../hooks/useAppearance";

interface Props {
  appearance: Appearance;
  isLoaded: boolean;
}

function setup(initial: Props, onError = vi.fn()) {
  const view = renderHook((props: Props) => useAppearance(props.appearance, props.isLoaded, onError), {
    initialProps: initial,
  });
  return { ...view, onError };
}

describe("useAppearance", () => {
  beforeEach(() => {
    setTheme.mockReset();
    setTheme.mockResolvedValue(undefined);
  });

  it("does not apply the value present when loading finishes", () => {
    const { rerender } = setup({ appearance: "dark", isLoaded: false });

    rerender({ appearance: "dark", isLoaded: true });

    expect(setTheme).not.toHaveBeenCalled();
  });

  it("does nothing while loading, even if the value changes", () => {
    const { rerender } = setup({ appearance: "system", isLoaded: false });

    rerender({ appearance: "light", isLoaded: false });

    expect(setTheme).not.toHaveBeenCalled();
  });

  it("applies each change after loading, mapping system to null", () => {
    const { rerender } = setup({ appearance: "system", isLoaded: true });

    rerender({ appearance: "light", isLoaded: true });
    expect(setTheme).toHaveBeenCalledTimes(1);
    expect(setTheme).toHaveBeenLastCalledWith("light");

    rerender({ appearance: "dark", isLoaded: true });
    expect(setTheme).toHaveBeenLastCalledWith("dark");

    rerender({ appearance: "system", isLoaded: true });
    expect(setTheme).toHaveBeenLastCalledWith(null);
    expect(setTheme).toHaveBeenCalledTimes(3);
  });

  it("reports a rejected setTheme once", async () => {
    setTheme.mockRejectedValue(new Error("denied"));
    const { rerender, onError } = setup({ appearance: "system", isLoaded: true });

    rerender({ appearance: "light", isLoaded: true });

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toMatch(/^Couldn't switch the appearance\./);
  });
});
