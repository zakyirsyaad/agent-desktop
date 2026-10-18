import { useEffect, useRef } from "react";
import { setTheme } from "@tauri-apps/api/app";
import { themeFor, type Appearance } from "../lib/appearance";

/**
 * Applies a changed appearance to the window. The value present when loading
 * finishes is skipped: the backend already applied it at startup.
 */
export function useAppearance(
  appearance: Appearance,
  isLoaded: boolean,
  onError: (message: string) => void,
): void {
  const applied = useRef<Appearance | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (applied.current === null) {
      applied.current = appearance;
      return;
    }
    if (applied.current === appearance) return;
    applied.current = appearance;
    setTheme(themeFor(appearance)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      onError(`Couldn't switch the appearance. ${message}`);
    });
  }, [appearance, isLoaded, onError]);
}
