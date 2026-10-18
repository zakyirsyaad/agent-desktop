# Design System Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every color, font and floating shadow in the app comes from the Zorvo design system's tokens, and a guard test keeps raw colors out.

**Architecture:** One Tailwind v4 `@theme` block in `src/styles/globals.css` declares the tokens as `--color-*`, `--font-*` and `--shadow-*`, so utilities like `text-fg-subtle` exist. A guard test scans `src/` for raw palette classes, with a shrinking list of files still pending migration. `Button` and `IconButton` primitives replace hand-rolled buttons. The default palette is cleared last.

**Tech Stack:** React 19, Tailwind CSS 4.1 (`@tailwindcss/vite`), Vitest 3 + Testing Library (jsdom), Tauri 2, `@fontsource-variable/instrument-sans` 5.3.0, `@fontsource-variable/geist-mono` 5.3.0.

**Spec:** `docs/superpowers/specs/2026-10-18-design-system-adoption-design.md` (its "Migration" table and the design system's "Adopting in the app" table give every class mapping).

## Global Constraints

- Dark only. Token values are the design system's **dark** theme values, exactly.
- Token names are the design system's names, prefixed `--color-` in `@theme` (`--color-fg-subtle`, `--color-surface-2`, …), plus the added `--color-status-merged: #c084fc`.
- Fonts come only from the two `@fontsource-variable` packages; family names `"Instrument Sans Variable"` and `"Geist Mono Variable"`. No Google Fonts URLs (the release CSP is `font-src 'self' data:`).
- Radius and spacing utilities are not redefined (Tailwind defaults already match).
- No layout, spacing or copy changes, except the permission card's left edge becoming a full `attention-border`.
- The 16 ANSI colors in `src/lib/xterm-options.ts` stay as they are.
- Commit messages: conventional commits, English, no co-author trailer.
- Run after every task: `pnpm lint` and `pnpm test` both pass.

## Review Focus

- A system without `document.fonts` (jsdom, an old WebView) → the app still renders: `loadAppFonts` resolves immediately. Test in Task 1.
- A font that never loads or fails → the app renders after the timeout instead of hanging on a blank window. Test in Task 1.
- A `Button` inside a `<form>` → clicking it does not submit the form unless `type="submit"` is passed. Test in Task 2.
- An `IconButton` with only an icon → screen readers and hover tooltips get its `label`. Test in Task 2.
- A file that is already clean but still on the pending list, or a new file with raw colors → the guard test fails with the file and line, so the list cannot drift. Test in Task 1.

## File map

- `src/styles/globals.css`: the `@theme` token block and base styles (Task 1), palette reset (Task 9).
- `src/lib/fonts.ts`: `loadAppFonts()` (Task 1).
- `src/main.tsx`: font imports and render after `loadAppFonts()` (Task 1).
- `src/test/design-tokens.test.ts`: the guard test and `PENDING` list (Task 1, shrunk by Tasks 3–8, removed in Task 9).
- `src/components/ui/Button.tsx`, `src/components/ui/IconButton.tsx`, `src/test/ui-primitives.test.tsx` (Task 2).
- The 40 component files, by group (Tasks 3–8).
- `src/lib/xterm-options.ts` (Task 8).

---

### Task 1: Tokens, fonts and the guard test

**Files:**
- Modify: `src/styles/globals.css`, `src/main.tsx`, `package.json` (+ lockfile)
- Create: `src/lib/fonts.ts`, `src/test/fonts.test.ts`, `src/test/design-tokens.test.ts`
- Modify: `docs/superpowers/specs/2026-10-18-design-system-adoption-design.md` (Fonts section, see Step 9)

**Interfaces:**
- Produces: `loadAppFonts(timeoutMs?: number): Promise<void>` in `src/lib/fonts.ts`; every token utility listed in the spec's token table; `PENDING: ReadonlySet<string>` inside the guard test, holding repo-relative paths (`"src/components/TopBar.tsx"`).

- [ ] **Step 1: Install the fonts**

Run: `pnpm add @fontsource-variable/instrument-sans@5.3.0 @fontsource-variable/geist-mono@5.3.0`
Expected: both in `dependencies` of `package.json`.

- [ ] **Step 2: Write the failing font loader tests** in `src/test/fonts.test.ts`

```ts
const setFonts = (fonts: unknown) =>
  Object.defineProperty(document, "fonts", { value: fonts, configurable: true });

it("resolves at once when document.fonts is missing", async () => {
  setFonts(undefined);
  await expect(loadAppFonts(1000)).resolves.toBeUndefined();
});
it("loads both families", async () => {
  const load = vi.fn().mockResolvedValue([]);
  setFonts({ load });
  await loadAppFonts(1000);
  expect(load).toHaveBeenCalledWith('400 14px "Instrument Sans Variable"');
  expect(load).toHaveBeenCalledWith('400 12px "Geist Mono Variable"');
});
it("resolves when a font fails to load", async () => {
  setFonts({ load: vi.fn().mockRejectedValue(new Error("x")) });
  await expect(loadAppFonts(1000)).resolves.toBeUndefined();
});
it("resolves after the timeout when loading hangs", async () => {
  vi.useFakeTimers();
  setFonts({ load: () => new Promise(() => {}) });
  const done = loadAppFonts(1000);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(done).resolves.toBeUndefined();
});
```

In `afterEach`: `vi.useRealTimers()` and `delete (document as { fonts?: unknown }).fonts` (jsdom has no `document.fonts` of its own).

- [ ] **Step 3: Run them** — `pnpm test src/test/fonts.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `loadAppFonts(timeoutMs = 1000): Promise<void>`** in `src/lib/fonts.ts`: `Promise.race` of `Promise.allSettled([...two loads])` and a `setTimeout` promise; never rejects; returns at once when `document.fonts?.load` is missing.

- [ ] **Step 5: Run them** — `pnpm test src/test/fonts.test.ts` → PASS.

- [ ] **Step 6: Wire fonts in `src/main.tsx`**: import `@fontsource-variable/instrument-sans` and `@fontsource-variable/geist-mono` before `./styles/globals.css`; render inside `loadAppFonts().then(() => …)`.

- [ ] **Step 7: Add the tokens to `src/styles/globals.css`**: an `@theme` block with every `--color-*` from the spec's token table (dark values from the design system `tokens.json`, plus `--color-status-merged: #c084fc`), `--font-sans`, `--font-mono` and `--shadow-popover`, `--shadow-dialog` exactly as in the spec. Remove the old `:root` variables; `body` uses `var(--color-bg)`, `var(--color-fg-secondary)`, `var(--font-sans)`. Do not clear the default palette yet.

- [ ] **Step 8: Write the guard test** `src/test/design-tokens.test.ts` with the two patterns from the spec's "Guard test" section, reading every `.ts`/`.tsx` under `src/` except `src/test/` (use `node:fs` and `node:path`). First with no `PENDING` list:

Run: `pnpm test src/test/design-tokens.test.ts`
Expected: FAIL listing 40 files (this confirms the patterns catch today's code).

Then add `PENDING` holding exactly those 40 paths, and two assertions:

```ts
it("has no raw colors outside the pending files", () => {
  expect(violations.filter((v) => !PENDING.has(v.file))).toEqual([]);
});
it("lists only files that still have raw colors", () => {
  const dirty = new Set(violations.map((v) => v.file));
  expect([...PENDING].filter((f) => !dirty.has(f))).toEqual([]);
});
```

Each violation is `{ file, line, match }` so a failure names where to look.

- [ ] **Step 9: Amend the spec's Fonts section**: the terminal no longer waits for the font itself; `main.tsx` renders after `loadAppFonts()`, so every terminal opens with the font already loaded and the terminal components stay synchronous (their tests assert an immediate open).

- [ ] **Step 10: Verify** — `pnpm lint` and `pnpm test` → all pass.

- [ ] **Step 11: Commit**

```bash
git add package.json pnpm-lock.yaml src/styles/globals.css src/main.tsx src/lib/fonts.ts src/test/fonts.test.ts src/test/design-tokens.test.ts docs/superpowers/specs/2026-10-18-design-system-adoption-design.md
git commit -m "feat: add design tokens, bundled fonts and a guard against raw colors"
```

### Task 2: Button and IconButton

**Files:**
- Create: `src/components/ui/Button.tsx`, `src/components/ui/IconButton.tsx`, `src/test/ui-primitives.test.tsx`

**Interfaces:**
- Consumes: token utilities from Task 1.
- Produces:
  - `Button(props: ButtonProps)`; `type ButtonVariant = "primary" | "outline" | "ghost" | "danger"`; `interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: ButtonVariant; icon?: ReactNode }` (default `"outline"`).
  - `IconButton(props: IconButtonProps)`; `interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { label: string; variant?: "ghost" | "primary"; children: ReactNode }` (default `"ghost"`).
  - Both named exports, both accept `ref` (React 19 ref-as-prop).

- [ ] **Step 1: Write the failing tests** in `src/test/ui-primitives.test.tsx`:
  - `"Button defaults to type button and does not submit a form"`: render inside `<form onSubmit={submit}>`, click, `expect(submit).not.toHaveBeenCalled()`; with `type="submit"` it is called once.
  - `"Button variants use their tokens"`: `primary` has classes `bg-primary` and `text-on-primary`; `outline` has `border-border-strong`; `ghost` has `text-fg-muted`; `danger` has `bg-danger-surface` and `text-danger`; no variant → outline.
  - `"Button renders its icon before the label"`.
  - `"disabled Button does not fire onClick"`.
  - `"Button appends className"`: `className="ml-2"` keeps the variant classes.
  - `"IconButton exposes its label"`: `getByRole("button", { name: "Close" })` and `title="Close"`.
  - `"IconButton primary uses primary tokens"`: `bg-primary`, `rounded-lg`; ghost: `rounded-md`, `text-fg-muted`.

- [ ] **Step 2: Run** — `pnpm test src/test/ui-primitives.test.tsx` → FAIL (modules not found).

- [ ] **Step 3: Implement both** with the class lists from the spec's "Primitives" section (shared focus classes `focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring`, `transition-colors`, `disabled:cursor-not-allowed disabled:opacity-40`). Hover: primary `hover:bg-primary-hover`, outline and ghost `hover:bg-surface-hover hover:text-fg`.

- [ ] **Step 4: Run** — same command → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: add Button and IconButton primitives"` with the three files.

### Tasks 3–7: Migrate a group of components

Every one of these tasks has the same shape. Per file: replace each raw color class by its token using the spec's "Migration" table and the design system's "Adopting in the app" table; replace `shadow-2xl` with `shadow-popover` on menus and the composer and `shadow-dialog` on dialogs; replace hand-rolled buttons of the Button or IconButton shape with the primitives (spec, "Primitives", last paragraph); then remove the file from `PENDING`.

- [ ] **Step 1:** Remove the group's files from `PENDING` in `src/test/design-tokens.test.ts`.
- [ ] **Step 2:** `pnpm test src/test/design-tokens.test.ts` → FAIL, listing only this group's violations.
- [ ] **Step 3:** Migrate the files.
- [ ] **Step 4:** `pnpm lint` and `pnpm test` → all pass (the group's existing component tests included).
- [ ] **Step 5:** Commit `refactor: move <group> onto design tokens`, listing in the body any amber or emerald class mapped by meaning rather than by the table.

| Task | Group | Files |
|---|---|---|
| 3 | shell | `src/App.tsx`, `src/components/PopoutApp.tsx`, `src/components/Sidebar.tsx`, `src/components/sidebar/NewSessionMenu.tsx`, `src/components/sidebar/SessionList.tsx`, `src/components/TopBar.tsx`, `src/components/topbar/PullRequestChip.tsx`, `src/components/ProfileFooter.tsx`, `src/components/AgentLogo.tsx` |
| 4 | chat | `src/components/ChatCanvas.tsx`, `src/components/chat/ReplyExtras.tsx`, `src/components/chat/ToolCallList.tsx`, `src/components/chat/ToolDetails.tsx`, `src/components/chat/UserMessageBar.tsx`, `src/components/MarkdownRenderer.tsx`, `src/components/MessageActionBar.tsx`, `src/components/ActionCard.tsx` |
| 5 | composer | `src/components/ComposerDock.tsx`, `src/components/composer/AttachmentChips.tsx`, `src/components/composer/ContextMeter.tsx`, `src/components/composer/FolderPicker.tsx`, `src/components/composer/MentionMenu.tsx`, `src/components/composer/OptionDropdown.tsx`, `src/components/composer/SlashCommandMenu.tsx` |
| 6 | panels | `src/components/changes/ChangesPanel.tsx`, `src/components/changes/FileDiff.tsx`, `src/components/changes/PullRequestList.tsx`, `src/components/FilesPanel.tsx`, `src/components/SettingsPanel.tsx`, `src/components/AuthPanel.tsx`, `src/components/AppPlaceholders.tsx` |
| 7 | onboarding and workspace | `src/components/Onboarding.tsx`, `src/components/onboarding/AgentsStep.tsx`, `src/components/onboarding/CopyButton.tsx`, `src/components/onboarding/DefaultAgentStep.tsx`, `src/components/onboarding/FolderStep.tsx`, `src/components/workspace/NewSessionView.tsx`, `src/components/workspace/WorkspaceSummary.tsx` |

Task 4 also: the permission card in `ActionCard.tsx` drops `border-l-4 border-l-amber-500` for `border border-attention-border bg-attention-surface` and its alert icon becomes `text-status-attention`. Tasks 4 and 6: `text-purple-400` → `text-status-merged`; diff line backgrounds → `bg-diff-added` / `bg-diff-removed`.

### Task 8: Terminal

**Files:**
- Modify: `src/lib/xterm-options.ts`, `src/components/TerminalView.tsx`, `src/components/TerminalDrawer.tsx`, `src/test/design-tokens.test.ts`
- Test: `src/test/terminal-view.test.tsx` (add one case)

**Interfaces:**
- Consumes: `--font-mono` stack from Task 1 (copied as a literal; xterm takes strings).

- [ ] **Step 1: Write the failing test** in `src/test/terminal-view.test.tsx`: `"terminal uses the design system font and colors"` asserting the options passed to `new Terminal` have `fontFamily` starting with `'"Geist Mono Variable"'`, `theme.background === "#0a0a0b"`, `theme.foreground === "#d4d4d8"`, `theme.cursor === "#fafafa"`, `theme.selectionBackground === "rgba(250, 250, 250, 0.2)"`, and `theme.red === "#ef4444"` (ANSI untouched).
- [ ] **Step 2: Run** — `pnpm test src/test/terminal-view.test.tsx` → FAIL on `fontFamily`.
- [ ] **Step 3:** Update `XTERM_OPTIONS` (one comment per changed value naming its token); migrate the two components' classes; remove both from `PENDING`.
- [ ] **Step 4:** `pnpm lint` and `pnpm test` → all pass.
- [ ] **Step 5: Commit** — `refactor: put the terminal on the design system font and colors`.

### Task 9: Clear the default palette

**Files:**
- Modify: `src/styles/globals.css`, `src/test/design-tokens.test.ts`

- [ ] **Step 1:** `PENDING` is empty after Tasks 3–8; delete it and the second assertion, so the test is just "no raw colors anywhere in `src/`".
- [ ] **Step 2:** `pnpm test src/test/design-tokens.test.ts` → PASS.
- [ ] **Step 3:** Add `--color-*: initial;` as the first line of the `@theme` block, before the token declarations.
- [ ] **Step 4:** `pnpm lint`, `pnpm test`, `pnpm build` → all pass. Then `grep -oE '\.(bg|text|border)-(neutral|amber|emerald|rose|white|black)' dist/assets/*.css | wc -l` → `0`.
- [ ] **Step 5: Commit** — `refactor: drop Tailwind's default palette for the design tokens`.

### Task 10: Verify in the app

- [ ] **Step 1:** `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings` → pass.
- [ ] **Step 2:** `pnpm tauri dev`. Look at onboarding, an empty workspace, a chat with a tool call and a permission request, the composer with the agent and mode menus open, the changes panel with a diff, settings, and the terminal drawer. Check: Instrument Sans in the UI, Geist Mono in code and the terminal, terminal grid aligned, sidebar and top bar titles truncate cleanly, focus ring visible when tabbing.
- [ ] **Step 3:** `pnpm tauri build` and open the built app once: fonts still load under the release CSP.
- [ ] **Step 4:** Add `status-merged` (dark `#c084fc`, light `#7e22ce`, usage "A merged pull request.") to the design system artifact's `tokens.json`, so the two stay in sync.
- [ ] **Step 5:** Fix anything found in Step 2 or 3 as its own `fix:` commit.
