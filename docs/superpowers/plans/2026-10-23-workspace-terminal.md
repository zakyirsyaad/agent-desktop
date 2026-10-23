# Workspace Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shell terminal per workspace in a drawer under the chat and the right panel, with several tabs per folder. It follows the folder of the session on screen.

**Architecture:**
- **Backend.** A new module `workspace_terminal.rs` starts the user's login shell in a checked folder through the existing `PtySessionManager`, using `shell-` ids and a `workspace-terminal` event. Every PTY is killed when the app quits.
- **Frontend.** The hook `useWorkspaceTerminals` keeps tabs per folder and one `PtyOutputStore` in the main window. The new `TerminalDrawer` renders the active tab with the existing `TerminalView`.

**Tech Stack:** Tauri 2, Rust (`portable-pty`), React 19, xterm 6, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-23-workspace-terminal-design.md`

## Global Constraints

- **The UI never sends a command, an argument or an environment.**
  - `workspace_terminal_open` takes only a folder path.
  - Input and resize go through the existing `send_input` / `resize_session`.
  - Only the backend makes `shell-` ids.
- **Folder check.** Every folder from the UI passes `files::ensure_known_workspace` first.
- **Shell.**
  - `$SHELL -l`, where `SHELL` comes from `env_resolver::cached_user_env()` and must be an absolute path to an executable file. Fall back to `/bin/zsh`.
  - Ids are `shell-<n>` from a process-wide `AtomicU64`. No new dependency.
- **Async and order.** Commands that spawn are `#[tauri::command(async)]`. `send_input` stays sync.
- **Sign-in stays unchanged.** `signin-` ids keep going to `sign-in-terminal`.
- **Privacy.** Nothing logs a shell's input or output.
- **Drawer.**
  - Height starts at 280 px and stays between 120 px and 70% of the window. It is not saved.
  - No drawer in popouts. No global keyboard shortcut. Escape goes to the shell.
  - Copy (sentence case): "The shell exited.", "Start a new shell", "New terminal", "Hide terminal", "Close <label>".
- **Design system.** Tokens only, with `bg-terminal-bg` for the terminal. Every focusable control gets `focus-ring`. Use the `src/components/ui/` primitives.
- **xterm in the release build.** Keep `esbuild.minifySyntax: false`, and check the feature in a release build.
- **Plan decision beyond the spec.** Output and exit events are kept for any `shell-` id the hook has not closed, even before `open` resolves, because the shell's first prompt can arrive first. Only ids already closed are ignored. Output never sets React state; only open, close and exit do.

## Review Focus

1. **The first prompt arrives before `open` resolves.** The shell prints its prompt or exits right away (a broken `.zshrc`) before the invoke returns. The tab must show that output, or show as exited. Test in Task 3.
2. **An output flood.** Something like `yes | head -100000` must not re-render the app per chunk. Test in Task 3 (output events cause no React render).
3. **A folder whose path has spaces.** It starts the shell in that exact folder. Test in Task 1.
4. **Opening fails.** For example, a worktree deleted outside Zorvo. The user sees a notice, and no dead tab is added. Test in Task 3.
5. **Clicking + twice quickly.** It makes two tabs with two different ids, both shown. Test in Task 3.

---

### Task 1: Backend: open and close a workspace shell

**Files:**
- Create: `src-tauri/src/workspace_terminal.rs`
- Modify: `src-tauri/src/lib.rs`: `mod workspace_terminal;`; route `shell-` ids in the PTY callback (~line 282); register both commands in `generate_handler!`
- Test: `src-tauri/tests/workspace_terminal_test.rs`

**Interfaces:**
- Produces:
  - `pub const EVENT: &str = "workspace-terminal";`
  - `pub fn is_workspace_terminal_id(id: &str) -> bool`: the `shell-` prefix plus 1–20 ASCII digits.
  - `pub fn next_terminal_id() -> String`
  - `pub fn shell_from(env: &HashMap<String, String>) -> String`
  - `pub fn start_shell(manager: &PtySessionManager, id: &str, folder: &Path, shell: &str) -> Result<(), String>`: args `["-l"]`, no extra env.
  - `pub fn event_payload(event: &PtyEvent) -> serde_json::Value`: the same shape as `sign_in_event_payload`, i.e. `{terminalId, kind:"output", data}` or `{terminalId, kind:"exit", exitCode}`.
  - `pub fn pty_event_route(id: &str) -> Option<&'static str>`: `Some(SIGN_IN_TERMINAL_EVENT)` for a `signin-` id, `Some(EVENT)` for a `shell-` id, `None` otherwise. The PTY callback in `lib.rs` uses it to choose the event.
  - `#[tauri::command(async)] pub fn workspace_terminal_open(store: State<AppStore>, pty: State<PtySessionManager>, path: String) -> Result<String, String>`
  - `#[tauri::command] pub fn workspace_terminal_close(pty: State<PtySessionManager>, id: String) -> Result<(), String>`
- Consumes: `PtySessionManager::{start_session, kill_session}`, `files::ensure_known_workspace`, `AppStore::is_known_workspace`, `env_resolver::cached_user_env`.

- [ ] **Step 1: Write the failing tests** in `workspace_terminal_test.rs`:
  - `ids_carry_the_shell_prefix_and_never_repeat`: 100 calls to `next_terminal_id()` give unique ids, and each one passes `is_workspace_terminal_id`.
  - `only_shell_ids_are_workspace_terminals`: `is_workspace_terminal_id` is false for `"signin-1"`, `"shell-"`, `"shell-1; rm"`, `"1"` and a 21-digit suffix.
  - `shell_comes_from_the_login_environment`:
    - `SHELL=/bin/sh` gives `/bin/sh`;
    - a missing value gives `/bin/zsh`;
    - `SHELL=sh` (relative) gives `/bin/zsh`;
    - `SHELL=/etc/hosts` (not executable) gives `/bin/zsh`.
  - `a_shell_starts_in_its_folder`, using a temp dir named `"work space"` (with a space):
    - collect the manager's `PtyEvent::Output` through its callback;
    - `start_shell(&manager, &id, &dir, "/bin/sh")`, then `write_stdin(&id, "pwd\n")`;
    - wait up to 5 s until the collected output contains the canonical dir path.
  - `closing_a_shell_that_already_exited_succeeds`: start `/bin/sh`, write `exit\n`, wait for `PtyEvent::Exit`, then a close through the same mapping the command uses returns `Ok(())`. Expose `pub fn close(manager: &PtySessionManager, id: &str) -> Result<(), String>`, which the command calls.
  - `close_refuses_ids_it_did_not_make`: `close(&manager, "signin-1")` is `Err`.
  - `pty_events_go_to_their_own_channel`: `pty_event_route("shell-3")` is `Some("workspace-terminal")`, `pty_event_route("signin-abc")` is `Some("sign-in-terminal")`, and `pty_event_route("other")` is `None`.
  - `events_carry_the_terminal_id`: `event_payload` for an Output and an Exit has the exact JSON shape above.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd src-tauri && cargo test --test workspace_terminal_test`
Expected: compile errors, because `zorvo_lib::workspace_terminal` does not exist yet.

- [ ] **Step 3: Implement the module, the commands and the event routing**
  - **`close`** returns `Ok(())` when `!manager.has_session(id)`, without matching error text: a shell that exited has already been removed by its reader thread. Otherwise it calls `kill_session`.
  - **`workspace_terminal_open`**:
    1. `ensure_known_workspace`;
    2. canonicalize the path;
    3. `shell_from(&cached_user_env().unwrap_or_default())`. If the login environment could not be read, the shell still starts, as `/bin/zsh`;
    4. `start_shell`;
    5. return the id.
  - **`lib.rs`.** In the PTY callback, replace the `is_sign_in_terminal_id` branch with a `match pty_event_route(session_id)`: the sign-in channel keeps `sign_in_event_payload`, and the workspace channel uses `event_payload`. Register both commands. Make the module `pub mod` if the integration test needs it, as `store` is.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd src-tauri && cargo test --test workspace_terminal_test && cargo test --test pty_session_test && cargo clippy --all-targets -- -D warnings`
Expected: all pass, with no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/workspace_terminal.rs src-tauri/src/lib.rs src-tauri/tests/workspace_terminal_test.rs
git commit -m "feat: open a login shell in a workspace folder"
```

### Task 2: Backend: end every PTY when Zorvo quits

**Files:**
- Modify: `src-tauri/src/lib.rs` (the final `.run(tauri::generate_context!())`, ~line 405)

**Interfaces:**
- Consumes: `PtySessionManager::kill_all() -> usize`, which is already covered by `pty_session_test::kill_all_ends_every_running_session`.

- [ ] **Step 1: Replace `.run(ctx).expect(..)`** with `.build(tauri::generate_context!()).expect("error while building tauri application").run(|app, event| { if let tauri::RunEvent::Exit = event { app.state::<PtySessionManager>().kill_all(); } })`. Add a one-line comment: a `nohup`ed job in a shell would otherwise outlive Zorvo.

- [ ] **Step 2: Verify**

Run: `cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: pass. The quit itself is checked by hand in Task 6, with `nohup sleep 300 &`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix: end every terminal when Zorvo quits"
```

### Task 3: Frontend: `useWorkspaceTerminals`

**Files:**
- Create: `src/hooks/useWorkspaceTerminals.ts`
- Test: `src/test/use-workspace-terminals.test.tsx` (fake events through the `listen` mock that `src/test/terminal-sign-in.test.tsx` uses)

**Interfaces:**
- Produces:

```ts
export interface WorkspaceTerminalTab {
  id: string;
  folderPath: string;
  /** 1-based, per folder; kept while the tab is open, so closing tab 1 does not rename tab 2. */
  number: number;
  status: "live" | "exited";
}
export interface WorkspaceTerminals {
  output: PtyOutputStore;
  tabsFor: (folderPath: string) => WorkspaceTerminalTab[];   // oldest first
  open: (folderPath: string) => Promise<string | null>;      // new tab id, null when it failed (reported)
  close: (id: string) => void;
  closeFolder: (folderPath: string) => void;
  send: (id: string, data: string) => void;                  // invoke("send_input", { sessionId: id, data })
  resize: (id: string, cols: number, rows: number) => void;  // invoke("resize_session", { sessionId: id, cols, rows })
}
export function useWorkspaceTerminals(onNotice: (message: string) => void): WorkspaceTerminals
```

- Consumes: `workspace_terminal_open` / `workspace_terminal_close` from Task 1, the `workspace-terminal` event and `createPtyOutputStore()`.

- [ ] **Step 1: Write the failing tests**
  - `opens a terminal for a folder`: `open("/w/a")` calls `workspace_terminal_open` with `{ path: "/w/a" }`, and `tabsFor("/w/a")` is `[{ id, folderPath: "/w/a", number: 1, status: "live" }]`.
  - `numbers a folder's tabs and keeps them`: tabs 1 and 2 are open; close tab 1; tab 2 keeps `number: 2`; the next open is `number: 3`.
  - `keeps output that arrives before open resolves`: the fake open emits output `"$ "` for `shell-1` before resolving `"shell-1"`, then `output.snapshot("shell-1")` is `"$ "`.
  - `marks a shell that exits before open resolves as exited`.
  - `marks a tab exited on its exit event`.
  - `ignores events after it unmounts`: unmount, emit output for a known id, and nothing is appended. Under `React.StrictMode` the listener is attached, detached and attached again, and `unlisten` resolves later, so a disposed flag checked inside the callback is what keeps output from being appended twice.
  - `ignores events for a closed tab`: after `close(id)`, a late exit adds nothing, `output.has(id)` is false, and `workspace_terminal_close` was called with `{ id }`.
  - `reports a failed open and adds no tab`: the open rejects with `"/w/gone is not one of your workspaces"`, `onNotice` gets `Could not open a terminal: /w/gone is not one of your workspaces`, and `tabsFor("/w/gone")` is `[]`.
  - `two quick opens make two tabs`: `Promise.all([open(f), open(f)])` gives two distinct ids, and `tabsFor(f)` has both.
  - `keeps each folder's tabs apart`: `tabsFor("/w/a")` and `tabsFor("/w/b")` are separate, and `closeFolder("/w/a")` closes only `/w/a`'s tabs.
  - `output does not re-render`: count renders with a counter in the `renderHook` callback. 1000 output events add 0 renders.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run src/test/use-workspace-terminals.test.tsx`
Expected: FAIL, the module is not found.

- [ ] **Step 3: Implement the hook**
  - One `listen("workspace-terminal")` for the hook's lifetime. The callback returns early once the effect's cleanup has set `disposed`.
  - Output goes to the store unless the id is in a closed-ids ref.
  - Exits go to an `exited` set held in state, plus a ref, so that an exit before `open` resolves still lands.
  - Tabs are state: an array, changed only by open, close and exit.
  - `close` calls `output.forget(id)`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run src/test/use-workspace-terminals.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useWorkspaceTerminals.ts src/test/use-workspace-terminals.test.tsx
git commit -m "feat: keep workspace terminals per folder"
```

### Task 4: `TerminalView` gets `autoFocus` and a label

**Files:**
- Modify: `src/components/TerminalView.tsx` (the `if (isLive) terminal.focus()` on line 60 and `aria-label="Agent terminal"`)
- Test: `src/test/terminal-view.test.tsx`

**Interfaces:**
- Produces: the props `autoFocus?: boolean` (default `true`, which keeps the sign-in dialog as it is) and `label?: string` (default `"Agent terminal"`, used as `aria-label`).

- [ ] **Step 1: Write the failing tests**
  - `does not take focus when autoFocus is false`: the composer `<textarea>` has focus, a `TerminalView` mounts with `autoFocus={false}`, and focus is still on the textarea. Spy on the xterm `focus` the existing tests mock, and expect it not called.
  - `takes focus by default`: the existing behavior, expecting `focus` called once.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm vitest run src/test/terminal-view.test.tsx`; expect the first test to FAIL.

- [ ] **Step 3: Implement.** Focus only when `isLive && autoFocus`. Add `autoFocus` to the effect's deps.

- [ ] **Step 4: Run the tests and confirm they pass**, along with `src/test/terminal-sign-in.test.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/test/terminal-view.test.tsx
git commit -m "feat: let a terminal view leave focus where it is"
```

### Task 5: `TerminalDrawer`

**Files:**
- Create: `src/components/terminal/TerminalDrawer.tsx` and `src/lib/terminal-labels.ts`
- Test: `src/test/terminal-drawer.test.tsx`, `src/test/terminal-labels.test.ts`

**Interfaces:**
- Consumes: `WorkspaceTerminals` and `WorkspaceTerminalTab` (Task 3), and `TerminalView` with `autoFocus` and `label` (Task 4).
- Note: a worktree session's folder name is its worktree directory's name (`filesFolder` falls back to `folderNameOf(cwd)`), so its tab reads like `agent-fix-parser · agent/fix-parser`. That is expected.
- Produces:
  - `export function tabLabel(folderName: string, branch: string | undefined, number: number): string` gives `"zorvo · main"` for number 1, `"zorvo · main 2"` for number 2, and `"zorvo"` without a branch. The branch is the folder's current one, passed in at render.
  - `export interface TerminalDrawerProps { folderPath: string; folderName: string; branch?: string; terminals: WorkspaceTerminals; onHide: () => void }`
  - `export function TerminalDrawer(props: TerminalDrawerProps)`

- [ ] **Step 1: Write the failing tests**
  - `tabLabel`: the three cases above.
  - `shows an empty state for a folder without terminals`: with an empty `tabsFor`, the drawer shows `No terminal in zorvo.` and a `New terminal` button, and **does not** call `open` by itself. Auto-opening from an effect would start two shells under StrictMode, and would start shells unasked when you switch to a folder.
  - `shows the folder's tabs and switches between them`: two tabs labelled `zorvo · main` and `zorvo · main 2`. Clicking the second gives it `aria-selected="true"` and renders its `TerminalView` (label = tab label).
  - `New terminal adds a tab, and its view takes focus`: the button `New terminal` calls `open`, and the new tab's view gets `autoFocus`.
  - `a session switch does not take focus`: rerender with another `folderPath` whose tabs exist; the active view has `autoFocus={false}`.
  - `Close <label> ends that shell`: it calls `close(id)`.
  - `an exited shell offers a new one`: a tab with `status: "exited"` shows "The shell exited." and a `Start a new shell` button, which calls `open(folderPath)`.
  - `Escape in the terminal leaves the drawer open`: `fireEvent.keyDown` with Escape on the view's container, then the drawer is still rendered and `onHide` was not called.
  - `the resize handle moves with the arrow keys`: `role="separator"`. ArrowUp grows the height by a step. It never goes below 120 px or above 70% of `window.innerHeight` (set `innerHeight` to 1000 and press ArrowUp 100 times, which gives a height of 700).
  - `Hide terminal calls onHide`.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm vitest run src/test/terminal-drawer.test.tsx src/test/terminal-labels.test.ts`; expect FAIL.

- [ ] **Step 3: Implement**
  - Tabs are `role="tablist"` / `role="tab"`.
  - The height lives in local state: start at 280, step 24 px, drag via pointer events on the separator.
  - Keep the active tab id per folder in local state. Fall back to the newest tab.
  - Set `autoFocus` only right after a user action in the drawer (opening it, +, picking a tab, Start a new shell). Track this in a ref that is set on those actions and cleared after mount.

- [ ] **Step 4: Run the tests and confirm they pass**, along with `pnpm vitest run src/test/design-tokens.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/TerminalDrawer.tsx src/lib/terminal-labels.ts src/test/terminal-drawer.test.tsx src/test/terminal-labels.test.ts
git commit -m "feat: add the terminal drawer"
```

### Task 6: Wire it in: top bar, layout, worktree delete, docs

**Files:**
- Modify:
  - `src/components/TopBar.tsx`: new props `isTerminalOpen?: boolean` and `onToggleTerminal?: () => void`. The button uses lucide `SquareTerminal`, `aria-label="Terminal"` and `aria-pressed`, sits beside the files button, and is hidden when `onToggleTerminal` is absent.
  - `src/App.tsx`: the hook call (before `useSessionActions`, which takes `closeFolder`) and the drawer state. The toggle handler opens a shell when it opens the drawer on a folder with no tabs. The drawer's folder is `shownFolderPath` (a session's `cwd` is already its worktree when it has one); its name is `filesFolder?.name`; its branch is `workspaceDetails?.branch`. Wrap the `<article>` and the right panels in `<div className="flex min-w-0 flex-1 flex-col"><div className="flex min-h-0 flex-1">…</div>{drawer}</div>`, so the drawer spans both.
  - `src/lib/session-worktree.ts`: `removeSessionWorktree(session, otherSessions, stopped, onRemoving?: (path: string) => void)`, called right before `invoke('remove_session_worktree', …)`.
  - `src/hooks/useSessionActions.ts`: a new dep `closeTerminals?: (folderPath: string) => void`, passed as `onRemoving`.
  - `CHANGELOG.md`, `CLAUDE.md`, `README.md`, as the spec's Docs section says.
- Test: `src/test/workspace-terminal-app.test.tsx`

**Interfaces:**
- Consumes: Tasks 3–5.

- [ ] **Step 1: Write the failing app-level tests** (render `App` with the fake store, as `acp-app.test.tsx` does):
  - `the Terminal button opens a shell in the session's folder`: clicking `Terminal` gives `aria-pressed="true"` and calls `workspace_terminal_open` exactly once with the session's `cwd`, even under `React.StrictMode` (wrap the render). The open happens in the click handler, not in an effect.
  - `opening the drawer again does not add a shell`: hide, then click `Terminal` again; there is no second open while the folder has a tab.
  - `switching to a folder without terminals opens none`: with the drawer open, switching to session B (another folder) shows the empty state, and `workspace_terminal_open` is not called for B.
  - `a worktree session's terminal starts in its worktree`: a session with `worktree.path` as `cwd` opens there, not in `repoPath`.
  - `switching sessions keeps the first folder's terminal`: open a terminal in session A, switch to B (another folder), then back to A. No second open for A, and A's tab is still there with its output.
  - `no Terminal button without a folder`.
  - `deleting a worktree session closes its terminals before the worktree goes`: in call order, `workspace_terminal_close` for that tab comes before `remove_session_worktree`.
  - `a worktree another session still uses keeps its terminals`: no close call.
  - `a popout has no Terminal button`: render `PopoutApp`.

- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm vitest run src/test/workspace-terminal-app.test.tsx`; expect FAIL.

- [ ] **Step 3: Implement the wiring and update the docs.** In `CLAUDE.md`'s "What this is", the sentence that says a PTY is used only for an agent's sign-in now also names the workspace terminal. Add a **Workspace terminal** paragraph to Architecture covering the ids, the event, the lifetime, and the rule that the UI sends only a folder.

- [ ] **Step 4: Run every check**

Run: `pnpm lint && pnpm test && pnpm build && (cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)`
Expected: all pass.

- [ ] **Step 5: Check by hand.** In `pnpm tauri dev` (the `tauri-dev-1422` setup) and in `pnpm tauri build`:
  - run `pnpm dev` in one tab and `git status` in a second;
  - switch sessions and come back, and check that the output is still there and the composer kept its focus;
  - type `exit`, then **Start a new shell**;
  - start `nohup sleep 300 &`, quit Zorvo, and check with `pgrep -f "sleep 300"` that nothing is left.

  Take screenshots for the PR.

- [ ] **Step 6: Commit**

```bash
git add src/components/TopBar.tsx src/App.tsx src/lib/session-worktree.ts src/hooks/useSessionActions.ts src/test/workspace-terminal-app.test.tsx CHANGELOG.md CLAUDE.md README.md
git commit -m "feat: open a terminal for the session's folder from the top bar"
```
