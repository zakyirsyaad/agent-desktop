/**
 * The dark theme's values for the Open Graph image, which is drawn outside the
 * page's CSS. Keyed by token name; src/test/site.test.tsx fails if one drifts
 * from app/globals.css.
 */
export const OG_COLORS = {
  bg: "#0a0a0b",
  border: "#27272a",
  fg: "#fafafa",
  "fg-muted": "#a1a1aa",
  "fg-subtle": "#8b8b94",
} as const;
