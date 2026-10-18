# Light mode — design

Date: 2026-10-18
Branch: `feat/light-mode` (on top of `feat/design-system-tokens`)
Builds on: `docs/superpowers/specs/2026-10-18-design-system-adoption-design.md`

## Goal

Zorvo follows the macOS appearance by default, and Settings lets the user
pin it to Light or Dark. Every window, the native chrome included, uses the
chosen theme from the first frame. The terminal stays dark in both themes.

## Scope

In:

1. An `appearance` setting (`"system" | "light" | "dark"`, default
   `"system"`) persisted in `state.json` and chosen in Settings.
2. Applying it app-wide through Tauri's app theme, from Rust at startup and
   from the UI when it changes.
3. Light values for every color and shadow token, switched by
   `prefers-color-scheme`.
4. A fixed-dark `terminal-bg` token for the terminal containers.

Out: a light ANSI palette (the terminal stays dark), per-window themes,
component restyling.

## How the theme is applied

One mechanism decides the theme everywhere: Tauri's app-wide
`set_theme(Option<Theme>)`. On macOS it sets `NSApp.appearance` to Aqua,
DarkAqua or nil (follow the system). Every window inherits it, including
popouts created later, and so do the native traffic lights, scrollbars,
context menus and file dialogs. The webview reports `prefers-color-scheme`
from its window's effective appearance, so the CSS only needs the media
query; there is no `data-theme` attribute.

- **At startup (Rust):** in `.setup`, right after the store is opened,
  read `settings.appearance` from the loaded state and call
  `app.handle().set_theme(..)`: `"light"` → `Some(Theme::Light)`,
  `"dark"` → `Some(Theme::Dark)`, anything else → `None`. A failed load
  leaves the system theme. This runs before the webview paints, so a
  pinned theme never flashes the other one.
- **On change (UI):** when `settings.appearance` changes after the state
  has loaded, call `setTheme` from `@tauri-apps/api/app` with `"light"`,
  `"dark"` or `null`. A rejected call is reported through the app's
  existing error reporting and leaves the setting saved.
- **Permission:** add `core:app:allow-set-app-theme` to
  `src-tauri/capabilities/default.json`.

**Assumption to prove first:** that the webview's `prefers-color-scheme`
follows `NSApp.appearance`. The first implementation step checks it in the
built app. If it does not, the fallback is to also set
`document.documentElement.dataset.theme` and duplicate the light token
block under `:root[data-theme="light"]`, keeping `set_theme` for the
native chrome.

## Setting

- TypeScript: `Settings.appearance: Appearance` where
  `type Appearance = "system" | "light" | "dark"`.
  `src/lib/persistence.ts` normalizes it: any value other than the three
  becomes `"system"`, and a file from an older build (no field) gets
  `"system"`.
- Rust: `Settings.appearance: String` in `src-tauri/src/store.rs`
  (`#[serde(default)]` already applies), so the field round-trips instead
  of being dropped on save. A plain string keeps an unknown value from
  failing the whole state load; the mapping to a theme happens where it is
  applied.
- Settings dialog: an **Appearance** select above **Default agent**, with
  options System, Light and Dark, styled like the Default agent select
  (`border-border-strong`, same label style). Changing it updates the
  setting at once; there is no Save step, matching Default agent.

## Tokens

`src/styles/globals.css` keeps the dark values in `@theme` and adds:

```css
@media (prefers-color-scheme: light) {
  :root { /* every --color-* and --shadow-* with its light value */ }
}
```

Light values are the design system's, except three darkened so that text
and edges meet their floor on `surface-hover` too:

| Token | Light |
|---|---|
| `bg` | `#fafafa` |
| `surface-1` | `#f4f4f5` |
| `surface-2` | `#ffffff` |
| `surface-3` | `#ffffff` |
| `surface-hover` | `#e4e4e7` |
| `overlay` | `rgba(9,9,11,0.4)` |
| `border` | `#e4e4e7` |
| `border-strong` | `#808088` (design system had `#84848c`: 2.92:1 on `surface-hover`) |
| `fg` | `#09090b` |
| `fg-secondary` | `#27272a` |
| `fg-muted` | `#52525b` |
| `fg-subtle` | `#67676f` |
| `primary` | `#09090b` |
| `primary-hover` | `#27272a` |
| `on-primary` | `#fafafa` |
| `focus-ring` | `#52525b` |
| `status-running` | `#047353` (was `#047857`: 4.32:1 on `surface-hover`) |
| `status-attention` | `#a34b08` (was `#b45309`: 3.96:1 on `surface-hover`) |
| `status-unread` | `#0369a1` |
| `status-merged` | `#7e22ce` |
| `danger` | `#b91c1c` |
| `danger-surface` | `#fef2f2` |
| `attention-surface` | `#fffbeb` |
| `attention-border` | `#e9c46a` |
| `diff-added` | `rgba(4,120,87,0.08)` |
| `diff-removed` | `rgba(185,28,28,0.08)` |
| `shadow-popover` | `0 12px 32px -8px rgba(9,9,11,0.18)` |
| `shadow-dialog` | `0 24px 64px -12px rgba(9,9,11,0.25)` |

`body` also gets `color-scheme: light dark` so native form controls and
scrollbars inside the page follow the theme.

The design system artifact gets the three corrected light values in the
same change, so the two stay in sync.

### Terminal

A new token `--color-terminal-bg: #0a0a0b`, declared in `@theme` and
**not** redefined in the light block. The xterm container in
`TerminalView` and the terminal body in `TerminalDrawer` use
`bg-terminal-bg` instead of `bg-bg`. The drawer header follows the theme.
`src/lib/xterm-options.ts` does not change.

## Contrast

Checked before writing this spec, light theme, every pair components use:
`fg`, `fg-secondary`, `fg-muted`, `fg-subtle` and the five status/danger
text colors at 4.5:1 or more on `bg`, `surface-1`, `surface-2` and
`surface-3`; the same except `fg-subtle` on `surface-hover`;
`border-strong` and `focus-ring` at 3:1 or more on every surface;
`danger` on `danger-surface`, text on `attention-surface`, `on-primary` on
`primary` and `primary-hover`, and status text on the diff tints. With the
three corrections above, nothing fails. `fg-subtle` on `surface-hover`
(4.42:1) stays forbidden by the design system's rule, as in dark.

The implementation commits this check as a test: it parses the light block
in `globals.css` and asserts these pairs, so a later token edit cannot
silently drop below the floor.

## Testing

- `persistence.ts`: `appearance` defaults to `"system"`, keeps the three
  valid values, and turns anything else into `"system"`.
- Settings: the select shows the current value and calls the change
  handler with the picked value.
- Applying: with `@tauri-apps/api/app` mocked, `setTheme` is called with
  `"light"`, `"dark"` or `null` when the setting changes after load, and
  not before the state has loaded.
- Rust: `Settings` round-trips `appearance`; a state file without it
  loads as an empty string; the startup mapping turns `"light"`/`"dark"`
  into themes and anything else into `None`.
- Contrast test as above; the existing raw-color guard keeps running.
- In the built app: pin Light with macOS in Dark and the reverse, check
  no flash at launch, a popout window, native dialog and scrollbars, and
  that System follows a live macOS appearance change. Walk the main
  screens in light: onboarding, sidebar, chat with a tool call and a
  permission card, composer menus, changes panel with a diff, settings.

## Risks

- **The webview might not follow `NSApp.appearance`.** Proven or refuted
  in the first step; the fallback is in "How the theme is applied".
- **Hard-coded dark assumptions** outside tokens (images, agent logos on
  dark backgrounds, `xterm.css`) only show in light. The walk-through in
  the built app is where they surface.
- **Startup flash** if the config window paints before `setup` sets the
  theme. Checked in the built app; if it flashes, the window is created
  hidden (`"visible": false`) and shown after the theme is applied.
