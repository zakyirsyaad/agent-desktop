/** The shapes of tokens.json this viewer reads. */
export type ThemeId = "dark" | "light";
export type TokenValue = string | Partial<Record<ThemeId, string>>;

export interface Token {
  name: string;
  value: TokenValue;
  usage?: string;
}

export interface TypeStyle {
  name: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
  letterSpacing?: string;
  usage?: string;
  sample?: string;
}

export interface Tokens {
  name: string;
  color: { themes: { id: ThemeId; name: string }[]; tokens: Token[] };
  type: {
    families: Record<string, string>;
    groups: { name: string; family: string; styles: TypeStyle[] }[];
  };
  spacing: { tokens: Token[] };
  radius: { tokens: Token[] };
  shadow: { tokens: Token[] };
  size: { tokens: Token[] };
}

/** Families that become one CSS variable per token, named after the token. */
const VARIABLE_FAMILIES = ["color", "spacing", "radius", "shadow", "size"] as const;

/** A token's value in a theme; a missing theme falls back to dark, the first theme. */
export function valueIn(value: TokenValue, theme: ThemeId): string {
  return typeof value === "string" ? value : (value[theme] ?? value.dark ?? "");
}

function declarations(tokens: Tokens, theme: ThemeId): string {
  const perToken = VARIABLE_FAMILIES.flatMap((family) =>
    tokens[family].tokens.map((t) => `--${CSS.escape(t.name)}: ${valueIn(t.value, theme)};`)
  );
  const fonts = Object.entries(tokens.type.families).map(([name, stack]) => `--font-${name}: ${stack};`);
  return [...perToken, ...fonts].join(" ");
}

/**
 * The variables previews and bundle.css read, as the artifact's generated tokens.css would
 * give them: dark by default, light when the system is light. `data-theme` on any element
 * pins its subtree to either, so a swatch or a logo tile can show the other theme.
 */
export function themeCss(tokens: Tokens): string {
  const dark = declarations(tokens, "dark");
  const light = declarations(tokens, "light");
  return [
    `:root, [data-theme="dark"] { color-scheme: dark; ${dark} }`,
    `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { color-scheme: light; ${light} } }`,
    `[data-theme="light"] { color-scheme: light; ${light} }`,
  ].join("\n");
}
