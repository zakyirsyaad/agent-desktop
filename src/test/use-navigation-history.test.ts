import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNavigationHistory } from "../hooks/useNavigationHistory";

describe("useNavigationHistory", () => {
  it("starts empty when no initial id is given", () => {
    const { result } = renderHook(() => useNavigationHistory());

    expect(result.current.current).toBeNull();
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
  });

  it("starts on the initial id", () => {
    const { result } = renderHook(() => useNavigationHistory("s-1"));

    expect(result.current.current).toBe("s-1");
    expect(result.current.canGoBack).toBe(false);
  });

  it("tracks the visited session and exposes the navigation flags", () => {
    const { result } = renderHook(() => useNavigationHistory("s-1"));

    act(() => {
      result.current.visit("s-2");
    });

    expect(result.current.current).toBe("s-2");
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);
  });

  it("returns the new current id from back() and forward()", () => {
    const { result } = renderHook(() => useNavigationHistory("s-1"));

    act(() => {
      result.current.visit("s-2");
      result.current.visit("s-3");
    });

    let stepped: string | null = null;
    act(() => {
      stepped = result.current.back();
    });
    expect(stepped).toBe("s-2");
    expect(result.current.current).toBe("s-2");
    expect(result.current.canGoForward).toBe(true);

    act(() => {
      stepped = result.current.forward();
    });
    expect(stepped).toBe("s-3");
    expect(result.current.current).toBe("s-3");
  });

  it("returns null from back() and forward() when the step is impossible", () => {
    const { result } = renderHook(() => useNavigationHistory("s-1"));

    let stepped: string | null = "sentinel";
    act(() => {
      stepped = result.current.back();
    });
    expect(stepped).toBeNull();
    expect(result.current.current).toBe("s-1");

    act(() => {
      stepped = result.current.forward();
    });
    expect(stepped).toBeNull();
    expect(result.current.current).toBe("s-1");
  });

  it("returns null from back() on an empty history", () => {
    const { result } = renderHook(() => useNavigationHistory());

    let stepped: string | null = "sentinel";
    act(() => {
      stepped = result.current.back();
    });

    expect(stepped).toBeNull();
    expect(result.current.current).toBeNull();
  });

  it("ignores a visit to the session that is already current", () => {
    const { result } = renderHook(() => useNavigationHistory("s-1"));

    act(() => {
      result.current.visit("s-2");
    });
    act(() => {
      result.current.visit("s-2");
    });

    expect(result.current.current).toBe("s-2");
    // A no-op visit must not create a step-back opportunity to itself.
    expect(result.current.canGoBack).toBe(true);
    act(() => {
      expect(result.current.back()).toBe("s-1");
    });
  });

  it("truncates the forward history when a new session is visited after back()", () => {
    const { result } = renderHook(() => useNavigationHistory("s-1"));

    act(() => {
      result.current.visit("s-2");
      result.current.visit("s-3");
      result.current.back();
      result.current.visit("s-4");
    });

    expect(result.current.current).toBe("s-4");
    expect(result.current.canGoForward).toBe(false);
    act(() => {
      expect(result.current.forward()).toBeNull();
    });
  });

  it("keeps a valid cursor after removing the current session", () => {
    const { result } = renderHook(() => useNavigationHistory("s-1"));

    act(() => {
      result.current.visit("s-2");
      result.current.visit("s-3");
    });
    act(() => {
      result.current.remove("s-3");
    });

    expect(result.current.current).toBe("s-2");
    expect(result.current.canGoForward).toBe(false);
    expect(result.current.canGoBack).toBe(true);
  });

  it("keeps the current session when an unrelated one is removed", () => {
    const { result } = renderHook(() => useNavigationHistory("s-1"));

    act(() => {
      result.current.visit("s-2");
      result.current.visit("s-3");
    });
    act(() => {
      result.current.remove("s-2");
    });

    expect(result.current.current).toBe("s-3");
    expect(result.current.canGoBack).toBe(true);
    act(() => {
      expect(result.current.back()).toBe("s-1");
    });
  });

  it("falls back to a null current after the last session is removed", () => {
    const { result } = renderHook(() => useNavigationHistory("s-1"));

    act(() => {
      result.current.remove("s-1");
    });

    expect(result.current.current).toBeNull();
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
  });

  it("exposes stable callbacks so consumers can put them in dependency arrays", () => {
    const { result, rerender } = renderHook(() => useNavigationHistory("s-1"));
    const firstVisit = result.current.visit;
    const firstBack = result.current.back;
    const firstForward = result.current.forward;
    const firstRemove = result.current.remove;

    act(() => {
      result.current.visit("s-2");
    });
    rerender();

    expect(result.current.visit).toBe(firstVisit);
    expect(result.current.back).toBe(firstBack);
    expect(result.current.forward).toBe(firstForward);
    expect(result.current.remove).toBe(firstRemove);
  });

  it("can drive a session switch callback through back()", () => {
    const onSelectSession = vi.fn();
    const { result } = renderHook(() => useNavigationHistory("s-1"));

    act(() => {
      result.current.visit("s-2");
    });
    act(() => {
      const target = result.current.back();
      if (target) onSelectSession(target);
    });

    expect(onSelectSession).toHaveBeenCalledWith("s-1");
  });
});
