# Design system adoption — design

Date: 2026-10-18
Branch: `feat/design-system-tokens`
Source of truth: the Zorvo Design System artifact
(https://claude.ai/artifact/8w2xRW4Fs8KZV7SyLYddpJ), its `tokens.json`,
README and "Adopting in the app" section.

## Goal

Every color, font and floating shadow in the app comes from the design
system's semantic tokens, so the look changes in one file and a raw color
can no longer slip back in. The app stays dark-only.

## Scope

In:

1. A token layer in Tailwind v4 `@theme` (colors, fonts, shadows) that
   replaces Tailwind's default palette.
2. Instrument Sans and Geist Mono bundled with the app.
3. A guard test that fails on any raw palette class or arbitrary hex color
   in `src/`.
4. Two React primitives, `Button` and `IconButton`, under
   `src/components/ui/`.
5. Migrating the 40 files that use raw colors today to the tokens.
6. The terminal (xterm) on Geist Mono and the token colors.

Out:

- Light mode. The light values exist in the design system; wiring them in
  (and checking every screen in it) is its own piece of work.
- Primitives beyond `Button` and `IconButton` (Select, Menu, Chip,
  Dialog stay hand-written, but on tokens).
- Layout, spacing or copy changes, except the permission card, whose
  colored left edge becomes a full border (an intentional change listed in
  the design system).

## Token layer

`src/styles/globals.css` gets one `@theme` block. It first clears the
default palette with `--color-*: initial;` and then declares only the
design system's colors, so a class like `text-neutral-500` or `bg-white`
generates no CSS at all once migration is done.

| Design system token | `@theme` variable | Example utilities |
|---|---|---|
| `bg` | `--color-bg` | `bg-bg` |
| `surface-1`, `surface-2`, `surface-3` | `--color-surface-1` … | `bg-surface-2` |
| `surface-hover` | `--color-surface-hover` | `hover:bg-surface-hover` |
| `overlay` | `--color-overlay` | `bg-overlay` |
| `border`, `border-strong` | `--color-border`, `--color-border-strong` | `border-border`, `border-border-strong` |
| `fg`, `fg-secondary`, `fg-muted`, `fg-subtle` | `--color-fg` … | `text-fg-subtle`, `placeholder-fg-subtle` |
| `primary`, `primary-hover`, `on-primary` | `--color-primary` … | `bg-primary text-on-primary` |
| `focus-ring` | `--color-focus-ring` | `focus-visible:outline-focus-ring` |
| `status-running`, `status-attention`, `status-unread` | `--color-status-*` | `bg-status-running` |
| `status-merged` (added, see below) | `--color-status-merged` | `text-status-merged` |
| `danger`, `danger-surface` | `--color-danger`, `--color-danger-surface` | `text-danger bg-danger-surface` |
| `attention-surface`, `attention-border` | `--color-attention-*` | `bg-attention-surface` |
| `diff-added`, `diff-removed` | `--color-diff-*` | `bg-diff-added` |

Values are the design system's dark theme, exactly as in its `tokens.json`.

- **Fonts:** `--font-sans: "Instrument Sans Variable", -apple-system,
  BlinkMacSystemFont, "Segoe UI", sans-serif;` and `--font-mono: "Geist
  Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;`.
- **Shadows:** `--shadow-popover` and `--shadow-dialog` from the design
  system. Existing `shadow-2xl` on menus becomes `shadow-popover`, on
  dialogs `shadow-dialog`; `shadow-lg` on the permission card is dropped.
- **Radius and spacing:** Tailwind's defaults already equal the design
  system (`rounded` 4px … `rounded-xl` 12px, 4px spacing step), so they
  stay untouched.
- The old `:root` variables (`--color-bg-base`, `--color-border`, …) are
  removed; `body` uses `var(--color-bg)`, `var(--color-fg-secondary)` and
  `var(--font-sans)`. `--color-border` keeps its name with the new value.

### Added token: `status-merged`

PR state "merged" is purple in the app today (`text-purple-400`, the
GitHub convention, two places). The design system has no token for it, so
this adds `status-merged`: dark `#c084fc` (7.5:1 on `bg`, 6.2:1 on `surface-3`), light `#7e22ce`
(6.7:1 on `bg`).
The design system artifact gets the same token in the same change.

## Fonts

Add `@fontsource-variable/instrument-sans` and
`@fontsource-variable/geist-mono` (both 5.3.0, OFL-1.1) and import them in
`src/main.tsx`. Vite bundles the `.woff2` files, which the release CSP
(`font-src 'self' data:`) allows; Google Fonts would be blocked.

The terminal measures its cell size when it opens, so a font that loads
afterwards makes the grid wrong. The terminal does not wait for the font
itself: `src/main.tsx` renders the app only after `loadAppFonts()`
(`src/lib/fonts.ts`) resolves. It loads both families through
`document.fonts.load` and gives up after a short timeout, so a missing font
never blocks startup. Every terminal therefore opens with the font already
loaded, and `TerminalView` and `TerminalDrawer` stay synchronous (their
tests assert an immediate open).

## Guard test

`src/test/design-tokens.test.ts` reads every `.ts` and `.tsx` file under
`src/` except `src/test/` and fails, naming file and line, on:

- a utility using a Tailwind default palette color:
  `(bg|text|border|ring|outline|fill|stroke|placeholder|divide|from|via|to|decoration|caret|accent|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}`
  or `-(white|black)` followed by a word boundary or `/`;
- an arbitrary color value: `-[#` followed by hex digits.

`src/lib/xterm-options.ts` is not exempt: its hex values are plain strings,
not classes, so the patterns do not match them.

It is written first and fails against today's code (TDD red); migration
turns it green.

## Primitives

`src/components/ui/Button.tsx`:

```tsx
type ButtonVariant = "primary" | "outline" | "ghost" | "danger";
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant; // default "outline"
  icon?: ReactNode;        // leading Lucide icon
}
```

Renders `<button type="button">` (overridable) with the design system's
Button styles: `text-xs font-medium`, `px-3 py-1.5`, `rounded-lg`, 150ms
color transition, `disabled:opacity-40 disabled:cursor-not-allowed`, and
`focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring`.
A passed `className` is appended for layout only (margins, width).

`src/components/ui/IconButton.tsx`:

```tsx
interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;                  // becomes aria-label and title
  variant?: "ghost" | "primary";  // default "ghost"
  children: ReactNode;            // one icon
}
```

`h-7 w-7`, `rounded-md` (ghost) or `rounded-lg` (primary), same states.

Both get unit tests: variant classes, `type="button"` default, disabled
state, `label` reaching `aria-label` and `title`, `className` appended.

They replace the hand-rolled buttons that match these shapes: the
composer's send and toolbar buttons, the permission card's choices,
settings and dialog actions, top bar and drawer icon buttons. Rows,
menu items and links that look like text stay as they are, on tokens.

## Migration

Classes map as in the design system's "Adopting in the app" table, plus:

| Today | Token |
|---|---|
| `text-purple-400` | `text-status-merged` |
| `ring-amber-*`, `focus:ring-*` used as focus | `focus-visible:outline-focus-ring` (see Primitives) |
| `border-amber-*`, `bg-amber-500/10` on the permission card and pending states | `border-attention-border`, `bg-attention-surface` |
| `text-amber-*`, `fill-amber-*` meaning "waiting on you" | `text-status-attention` |
| `text-emerald-*`, `bg-emerald-*` | `text-status-running`, `bg-status-running`; tinted emerald surfaces → `bg-diff-added` |
| `text-rose-*`, `text-red-*` | `text-danger`; `bg-rose-950/*`, `bg-rose-900` → `bg-danger-surface` |
| `bg-white`, `text-white` on primary actions | `bg-primary`/`primary-hover`, `text-fg` |
| `bg-black`, `text-black`, `bg-black/70` | `bg-bg`, `text-on-primary`, `bg-overlay` |
| opacity variants of neutrals (`border-neutral-800/60`) | the plain token (`border-border`) |

Where a mapping is ambiguous (amber that is decoration, not state), the
token is chosen by meaning, and the commit message lists those calls.

Order, one commit each so review stays small:

1. Tokens, fonts, guard test (red).
2. `Button` and `IconButton` with tests.
3. Shell: `App`, `PopoutApp`, `Sidebar`, `sidebar/*`, `TopBar`, `topbar/*`, `ProfileFooter`.
4. Chat: `ChatCanvas`, `chat/*`, `MarkdownRenderer`, `MessageActionBar`, `ActionCard`.
5. Composer: `ComposerDock`, `composer/*`.
6. Panels: `changes/*`, `FilesPanel`, `SettingsPanel`, `AuthPanel`, `AppPlaceholders`.
7. Onboarding and workspace: `Onboarding`, `onboarding/*`, `workspace/*`.
8. Terminal: `TerminalView`, `TerminalDrawer`, `xterm-options.ts`.
9. Palette reset (`--color-*: initial`); guard test green.

## Terminal colors

`XTERM_OPTIONS.theme`: `background` `#0a0a0b` (`bg`), `foreground`
`#d4d4d8` (`fg-secondary`), `cursor` `#fafafa` (`fg`, was amber),
`selectionBackground` `rgba(250, 250, 250, 0.2)`. The 16 ANSI colors stay:
they belong to the programs running in the terminal, not to the brand.
`fontFamily` becomes the `--font-mono` stack. xterm takes literal colors,
so these stay hex in that file, with a comment naming each token.

## Verification

- `pnpm lint`, `pnpm test` (guard test included), `pnpm build`.
- Rust checks are untouched by this change but run once before the PR:
  `cargo test`, `cargo clippy --all-targets -- -D warnings`.
- `pnpm tauri dev` and a look at: onboarding, an empty workspace, a chat
  with a tool call and a permission request, the composer with menus open,
  the changes panel with a diff, settings, and the terminal drawer
  (font, cursor, grid alignment). Screens compared against the design
  system's previews.
- `pnpm tauri build` once, since only the release build applies the CSP
  that blocks external fonts.

## Risks

- **Silent loss of a color** when the palette is cleared: a class no one
  migrated renders unstyled. The guard test runs before the reset commit
  and must be green first.
- **Font metrics** shift text widths slightly (Instrument Sans is a little
  wider than SF Pro). Truncation in the sidebar and top bar is checked on
  screen.
- **Terminal grid** misaligned if the font loads late; handled by waiting
  for the font before `open()`.
