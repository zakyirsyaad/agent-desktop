# Light Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zorvo follows the macOS appearance by default, Settings can pin it to Light or Dark, and the terminal stays dark.

**Architecture:** Light token values sit in a `@media (prefers-color-scheme: light)` block in `globals.css`. The theme is chosen by Tauri's app-wide `set_theme` (macOS `NSApp.appearance`), applied from Rust at startup and from the UI when the setting changes; the webview's color-scheme follows the window. A fixed-dark `terminal-bg` token keeps terminals dark.

**Tech Stack:** Tauri 2.12 (Rust, `AppHandle::set_theme`), React 19, Tailwind CSS 4.1, `@tauri-apps/api/app` `setTheme`, Vitest + Testing Library, Rust integration tests in `src-tauri/tests/`.

**Spec:** `docs/superpowers/specs/2026-10-18-light-mode-design.md` (its token table holds every light value).

## Global Constraints

- Setting values are exactly `"system" | "light" | "dark"`; default `"system"`; anything else is treated as `"system"`.
- Dark stays the default token set in `@theme`; light values only in `@media (prefers-color-scheme: light) { :root { … } }`, exactly the spec's table (including `border-strong #808088`, `status-running #047353`, `status-attention #a34b08`).
- `--color-terminal-bg: #0a0a0b` is declared once in `@theme` and never redefined for light. `src/lib/xterm-options.ts` does not change.
- The UI calls `setTheme` only when `settings.appearance` changes after the state has loaded, never for the initial value (Rust applies that).
- No raw colors (the guard test in `src/test/design-tokens.test.ts` keeps running); no component restyling beyond the terminal containers and the new Settings select.
- Conventional commits in English, no co-author trailer. `pnpm lint`, `pnpm test`, and for Rust tasks `cargo test` and `cargo clippy --all-targets -- -D warnings` pass after every task.

## Review Focus

- A `state.json` from an older build (no `appearance`) or with a junk value → the app opens in the system theme and the whole state still loads. Tests in Tasks 2 and 3.
- The user pins Light, then Dark, then System → each change calls `setTheme` once with `"light"`, `"dark"`, `null`; the first render after load calls nothing. Test in Task 3.
- `setTheme` rejects (permission missing, old runtime) → a notice is shown and the setting stays saved. Test in Task 3.
- A later token edit drops a light text color below 4.5:1 → the contrast test fails naming the pair. Test in Task 1.
- Terminal containers in light → still `#0a0a0b`, not `bg`. Test in Task 1.

## File map

- `src/styles/globals.css`: light block, `color-scheme`, `terminal-bg` (Task 1).
- `src/test/theme-contrast.test.ts` (Task 1).
- `src/components/TerminalView.tsx`, `src/components/TerminalDrawer.tsx`: terminal body on `bg-terminal-bg` (Task 1).
- `src-tauri/src/store.rs` (`Settings.appearance`), `src-tauri/src/appearance.rs` (new: `theme_for`), `src-tauri/src/lib.rs` (setup applies it), `src-tauri/capabilities/default.json`, `src-tauri/tests/store_test.rs` (Task 2).
- `src/types/index.ts`, `src/lib/persistence.ts`, `src/lib/appearance.ts` (new), `src/hooks/useAppearance.ts` (new), `src/App.tsx`, `src/components/SettingsPanel.tsx`, tests (Task 3).

---

### Task 1: Light tokens, terminal background, contrast test

**Files:**
- Modify: `src/styles/globals.css`, `src/components/TerminalView.tsx:76`, `src/components/TerminalDrawer.tsx:228,231`
- Create: `src/test/theme-contrast.test.ts`
- Test: `src/test/terminal-view.test.tsx`, `src/test/terminal-drawer.test.tsx` (one assertion each)

**Interfaces:**
- Produces: utility `bg-terminal-bg`; the light block other tasks rely on.

- [ ] **Step 1: Write the failing contrast test** `src/test/theme-contrast.test.ts`. It reads `src/styles/globals.css`, extracts the `--color-*` values inside the `@media (prefers-color-scheme: light)` block (hex only; skip `rgba` tokens) and asserts, with the WCAG 2 relative-luminance formula:
  - text ≥ 4.5 on each of `bg`, `surface-1`, `surface-2`, `surface-3`: `fg`, `fg-secondary`, `fg-muted`, `fg-subtle`, `status-running`, `status-attention`, `status-unread`, `status-merged`, `danger`;
  - text ≥ 4.5 on `surface-hover`: the same list minus `fg-subtle`;
  - ≥ 3 on `bg`, `surface-1`, `surface-2`, `surface-hover`: `border-strong`, `focus-ring`;
  - ≥ 4.5: `danger` on `danger-surface`; `fg`, `fg-secondary`, `fg-subtle` on `attention-surface`; `on-primary` on `primary` and on `primary-hover`.
  - A failure message names the pair and the ratio. Also assert the light block does not redefine `--color-terminal-bg`.
- [ ] **Step 2:** `pnpm test src/test/theme-contrast.test.ts` → FAIL (no light block).
- [ ] **Step 3:** Add to `globals.css`: `--color-terminal-bg: #0a0a0b;` in `@theme`; the `@media (prefers-color-scheme: light) { :root { … } }` block with every `--color-*` (except `terminal-bg`) and both `--shadow-*` light values from the spec's table; `color-scheme: light dark;` on `body`.
- [ ] **Step 4:** Terminal containers: `TerminalView.tsx:76` and the drawer's terminal body and empty state (`TerminalDrawer.tsx:228,231`) use `bg-terminal-bg`; the drawer's outer wrapper and header keep their tokens. Add one assertion per terminal test that the terminal container has class `bg-terminal-bg`.
- [ ] **Step 5:** `pnpm lint`, `pnpm test` → pass.
- [ ] **Step 6: Commit** — `feat: add light theme tokens and keep the terminal dark`.

### Task 2: Appearance in the Rust store and at startup

**Files:**
- Modify: `src-tauri/src/store.rs:74-79`, `src-tauri/src/lib.rs` (`.setup`, after the store is opened and before the env warm-up), `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/appearance.rs` (register with `mod appearance;` in `lib.rs`)
- Test: `src-tauri/tests/store_test.rs`, unit tests in `appearance.rs`

**Interfaces:**
- Produces: `Settings.appearance: String` (camelCase `appearance` on the wire); `pub fn theme_for(appearance: &str) -> Option<tauri::Theme>`.

- [ ] **Step 1: Write failing tests:**
  - `store_test.rs`: `settings_round_trip_appearance` (save state with `appearance: "light"`, load it back, equal); `state_without_appearance_loads_empty` (a JSON settings object without the key loads with `appearance == ""` and the rest intact).
  - `appearance.rs` `#[cfg(test)]`: `"light"` → `Some(Theme::Light)`, `"dark"` → `Some(Theme::Dark)`, `"system"`, `""`, `"LIGHT"`, `"sepia"` → `None`.
- [ ] **Step 2:** `cd src-tauri && cargo test` → FAIL (field and function missing).
- [ ] **Step 3:** Add the field with a doc comment ("`system`, `light` or `dark`; anything else follows the system"), `theme_for`, and in `.setup`: load the state from the just-opened store and call `app.handle().set_theme(appearance::theme_for(&state.settings.appearance))`; a load error leaves the system theme and is not reported again (the UI reports load failures). Add `"core:app:allow-set-app-theme"` to the capability's `permissions`.
- [ ] **Step 4:** `cargo test`, `cargo clippy --all-targets -- -D warnings` → pass.
- [ ] **Step 5: Commit** — `feat: persist the appearance setting and apply it at startup`.

### Task 3: Appearance setting in the UI

**Files:**
- Modify: `src/types/index.ts:119-122`, `src/lib/persistence.ts:11,87-93`, `src/App.tsx` (near line 95 and the `SettingsPanel` at ~700), `src/components/SettingsPanel.tsx`
- Create: `src/lib/appearance.ts`, `src/hooks/useAppearance.ts`, `src/test/use-appearance.test.tsx`
- Test: `src/test/persistence.test.ts`, `src/test/settings-panel.test.tsx`

**Interfaces:**
- Consumes: Rust `Settings.appearance` (Task 2) on the wire.
- Produces:
  - `src/lib/appearance.ts`: `export type Appearance = "system" | "light" | "dark"`; `normalizeAppearance(value: unknown): Appearance`; `themeFor(appearance: Appearance): "light" | "dark" | null`.
  - `Settings.appearance: Appearance`.
  - `useAppearance(appearance: Appearance, isLoaded: boolean, onError: (message: string) => void): void` — calls `setTheme(themeFor(appearance))` from `@tauri-apps/api/app` whenever `appearance` changes after `isLoaded` became true, never for the value present when loading finished; a rejection calls `onError` with `Couldn't switch the appearance. ${message}`.
  - `SettingsPanelProps.appearance: Appearance` and `onChangeAppearance: (appearance: Appearance) => void`.

- [ ] **Step 1: Write failing tests:**
  - `persistence.test.ts`: missing `appearance` → `"system"`; `"light"` and `"dark"` kept; `"sepia"`, `42` → `"system"`.
  - `use-appearance.test.tsx` (mock `@tauri-apps/api/app`): no call on the render where `isLoaded` turns true; rerender with `"light"` → `setTheme("light")` once; then `"dark"` → `setTheme("dark")`; then `"system"` → `setTheme(null)`; while `isLoaded` is false nothing is called; a rejected `setTheme` calls `onError` once with a message starting `Couldn't switch the appearance.`.
  - `settings-panel.test.tsx`: a combobox named "Appearance" shows the current value; selecting "Light" calls `onChangeAppearance("light")`; options are System, Light, Dark in that order.
- [ ] **Step 2:** run those three files → FAIL.
- [ ] **Step 3:** Implement: the type and helpers; `emptyPersistedState` gets `appearance: "system"`; `persistence.ts` normalizes via `normalizeAppearance`; the hook; the Settings select above "Default agent", same label and select classes as Default agent; `App.tsx` passes `state.settings.appearance` and `updateSettings({ appearance })`, and calls `useAppearance(state.settings.appearance, isLoaded, reportError)`.
- [ ] **Step 4:** `pnpm lint`, `pnpm test` → pass (other tests that build `Settings` literals may need `appearance: "system"` added).
- [ ] **Step 5: Commit** — `feat: choose System, Light or Dark appearance in Settings`.

### Task 4: Verify in the built app (controller)

- [ ] **Step 1:** `pnpm tauri build --bundles app`; open the app.
- [ ] **Step 2:** The spec's assumption: with macOS in Dark, pick Light in Settings → the whole UI and the native chrome turn light. If only the chrome changes, rule on the spec's fallback (`data-theme` + duplicated light block) and dispatch it as a fix task with its own review.
- [ ] **Step 3:** Quit and relaunch with Light pinned → no dark flash; open a popout → light; a native file dialog and scrollbars → light; set System → follows a live macOS appearance change.
- [ ] **Step 4:** Walk onboarding (via "Run setup again", without completing it), sidebar, a chat with a tool call, composer menus, changes panel with a diff, settings, in light. Anything off goes to a fix task.
- [ ] **Step 5:** Sync the design system artifact's light values for `border-strong`, `status-running`, `status-attention`.
