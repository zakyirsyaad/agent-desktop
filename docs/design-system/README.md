# Zorvo design system

Zorvo is a native macOS desktop for every coding agent a developer already uses: Claude Code, Codex and Qwen Code in a chat UI over ACP, Aider and Oh-My-Pi as real terminals. The identity is futuristic and a little mysterious in what it says, clean and monochrome in how it looks. The symbol and the type carry the brand; color only ever means a state.

- [`tokens.json`](tokens.json): every color, type style, space, radius, shadow and size, with a usage note each.
- [`components.md`](components.md): how each component looks and what its caller provides.
- [Brand brief](../brand/zorvo-brand-brief.md): name, positioning and the symbol's construction.
- [Visual reference](https://claude.ai/artifact/8w2xRW4Fs8KZV7SyLYddpJ): swatches, type specimens and live component previews.

## In the code

[`src/styles/globals.css`](../../src/styles/globals.css) is the source of truth. Its `@theme` block holds the dark values and turns each token into Tailwind utilities, so `surface-2` is `bg-surface-2`, `fg-muted` is `text-fg-muted` and `border-strong` is `border-border-strong`. The `@media (prefers-color-scheme: light)` block overrides the same variables for light mode.

- Change a value in `globals.css` and `tokens.json` together. `src/test/design-system-docs.test.ts` fails when they drift.
- Never write a raw color in a component: no `bg-neutral-800`, `text-white` or `bg-[#121212]`. `src/test/design-tokens.test.ts` fails on them.
- Light-mode text and edges must meet their contrast floor; `src/test/theme-contrast.test.ts` checks them.
- Use the primitives in `src/components/ui/` (`Button`, `IconButton`) before styling a `<button>` by hand.
- Give every focusable control the `focus-ring` utility (`focus-ring-within` on a wrapper around a radio or checkbox).
- Shadows are `shadow-popover` and `shadow-dialog`. They read `--elevation-*`, because Tailwind inlines a `--shadow-*` value at build time and a theme could not override it.

## Content fundamentals

Write short, declarative sentences. Confident, never loud.

- **Name the agents.** "Claude Code, Codex, Qwen and Aider", never "AI" in general. Other agents' names say Zorvo works with them, never that they endorse it.
- **Sentence case** for every heading, button and menu item: "Allow once", "New session", "Choose your default agent".
- **You and your.** The product speaks to the developer: "Your sessions", "Bring the agent you already use". The UI never says "I".
- **No exclamation marks, no emoji**, and none of "seamless", "unlock", "empower", "simply", "just".
- **Buttons are verbs**, one to three words: "Send", "Allow", "Deny", "Open in Finder".
- **Errors say what happened, then what to do**: "Codex isn't signed in. Run `codex login`, then check again."

Real copy to match:

> Every coding agent. One desktop.
>
> Claude Code, Codex, Qwen and Aider in one native app. Bring the agent you already use. No lock-in, no API keys.

## Logo

The logo is the **double prompt** symbol beside the `zorvo` wordmark. Two `>` prompts step down to the right and end in a `_` cursor: the steps trace a Z, the prompts say terminal, two of them say more than one agent.

- Set the wordmark in `wordmark` (Instrument Sans 600, lowercase, −0.04em). Never `ZORVO`, never another typeface.
- Lock up symbol left, wordmark right, the gap 30% of the symbol's height. Keep clear space equal to the symbol's height on every side.
- Use [`zorvo-symbol.svg`](../brand/assets/zorvo-symbol.svg) at 32px and up, [`zorvo-symbol-small.svg`](../brand/assets/zorvo-symbol-small.svg) under 32px (no cursor, heavier stroke). Both stroke in `currentColor`: inline them and color them with a text token.
- The app icon is the paper symbol on an ink macOS squircle, the symbol about 55% of the tile (`src-tauri/icons/`).
- Never recolor the symbol, add gradients or glows, outline it or rotate it.

## Color

Monochrome on the zinc scale, in a dark and a light theme. The app follows the Mac's appearance, or the Appearance setting (System, Light, Dark) in Settings. The terminal stays dark in both themes.

- Paint the canvas `bg`; chrome (sidebar, top bar) `surface-1`; the composer, cards and inputs `surface-2`; menus and popovers `surface-3`. Step up one surface per layer, never skip back down.
- Set headings and the active item in `fg`, message text and button labels in `fg-secondary`, icons and secondary labels in `fg-muted`, hints, timestamps and paths in `fg-subtle`. Don't put `fg-subtle` on `surface-hover`.
- Draw hairlines with `border`. Use `border-strong` only where an edge must be seen: inputs, the outline button.
- Give a view **one** primary action, filled `primary` with `on-primary` text. Everything else is outline or ghost.
- Use status colors only for state, never decoration, and always next to a word, an icon or a tooltip:
  - `status-running`: an agent is working, a check passed, a line was added.
  - `status-attention`: an agent is waiting on you.
  - `status-unread`: a session finished while you were elsewhere.
  - `status-merged`: a merged pull request.
  - `danger`: errors and destructive actions.
- Mark a permission request with `attention-surface` and a full `attention-border`, never a colored left edge alone.
- Paint the terminal and its empty state `terminal-bg`, with hints in `terminal-fg-subtle`. Agents' ANSI colors are tuned for a dark ground, so these two tokens keep their dark values in light mode.

## Type

- Set all UI in **Instrument Sans** (`sans`) and all code, commands, paths and branch names in **Geist Mono** (`mono`). Both are free under the SIL Open Font License. The app bundles them through `@fontsource-variable/instrument-sans` and `@fontsource-variable/geist-mono`, because its Content Security Policy blocks Google Fonts.
- `ui` (12px) is the workhorse: buttons, menus, rows. Messages and the composer use `body` (14px). Hints use `caption` (11px). `micro` (10px) is for badges, never sentences.
- Marketing headlines use `display` and `headline`: tight tracking, two lines at most.
- Never go below 10px. Never use weights other than 400, 500 and 600.

## Space, shape and elevation

- Space with the `space-*` steps; the app is dense, so `space-1.5` and `space-2` do most of the work. Give cards `space-4` and dialogs `space-5`.
- Round by size: `radius-sm` for menu items and inline chips, `radius-md` for icon buttons and rows, `radius-lg` for buttons and menus, `radius-xl` for the composer, cards and dialogs. `radius-full` is for status dots only.
- Float menus and the composer with `shadow-popover`, dialogs with `shadow-dialog` over `overlay`. Nothing else casts a shadow.
- Controls are `size-control` (28px) square or tall; icons are `size-icon` (14px).

## States and motion

- **Hover:** fill `surface-hover` and lift the label one text step (`fg-muted` → `fg`).
- **Focus:** a solid 1px `focus-ring` with 1px offset on every focusable control. Never remove it without a replacement.
- **Disabled:** `cursor: not-allowed` and no hover change. A primary button turns flat, `surface-hover` with an `fg-muted` label, rather than a faded fill; outline, ghost and danger drop to 40% opacity.
- **Motion:** 150ms color and background transitions only. The one animation is the `status-running` dot's pulse; stop it under `prefers-reduced-motion`.

## Iconography

Use **Lucide** (`lucide-react`) at `size-icon`, stroke width 1.75, colored by the text token of their context (`fg-muted` by default). Agents appear with their own logos at 14–16px; never recolor an agent's logo. No emoji anywhere in the UI.
