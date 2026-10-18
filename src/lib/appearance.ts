export type Appearance = "system" | "light" | "dark";

export function normalizeAppearance(value: unknown): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

/** The window theme to force, or null to follow the system. */
export function themeFor(appearance: Appearance): "light" | "dark" | null {
  return appearance === "system" ? null : appearance;
}
