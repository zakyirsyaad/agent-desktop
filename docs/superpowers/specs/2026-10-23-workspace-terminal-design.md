# Workspace terminal — design

Date: 2026-10-23
Branch: `feat/workspace-terminal`, from `main` at 00fdd64.

## Goal

A real shell inside Zorvo, the way Claude Code desktop has a Terminal panel: the user's own
login shell, started in the folder of the session on screen, for any command (`git status`,
`pnpm dev`, a test run). Zorvo had a `TerminalDrawer` until PR #52, but it only showed a
terminal agent's PTY and said "No running session" for ACP sessions. This is a new feature,
not a restore.

No sign-in, no prompt: the shell opens at once.

## Decisions

| Topic | Decision |
|---|---|
| Placement | A drawer along the bottom of the content area, under the chat column (composer included) and under the right panel (Files, Changes, Diff), across their full width. The right panel stays open above it, so a diff and a test run show together. |
| Tabs | Several per folder. The drawer shows a tab bar with a **+** button; the first tab opens by itself when the drawer opens on a folder that has none. |
| Which folder | The folder of the session on screen: its worktree when it has one, else its workspace. A new-session draft uses its picked folder. No folder means no drawer button. |
| Switching sessions | The drawer shows the tabs of the shown folder only. Other folders' shells keep running and come back, scrollback included, when you return. A folder with no terminal shows "No terminal in <folder>." and **New terminal**; a shell is never started unasked by a switch. |
| Shell | `$SHELL -l` from the resolved login environment (`env_resolver.rs`), falling back to `/bin/zsh`. The UI never sends a command, argument or environment. |
| Lifetime | Closing a tab ends its shell. Hiding the drawer does not. A webview reload ends every shell (`end_orphaned_sessions`, which already kills every PTY). Quitting Zorvo ends every shell. Deleting a worktree session ends the shells in that worktree. Nothing is saved to disk; a restart starts with no terminals. |
| Keyboard | Every key, Escape and Ctrl+C included, goes to the shell. The drawer opens and closes only with buttons; there is no global shortcut (the user declined shortcuts). |
| Popouts | No drawer in popout windows: a popout only renders the main window's snapshots. |
| Background tasks | Unchanged. Its scan only lists processes under an agent, and a workspace shell is a child of Zorvo, so shells neither show there nor pollute it. Listing a busy shell would need a new process scan; left out. |
| Left out (YAGNI) | Remembering the drawer height, a tab limit, `TERM_PROGRAM`, saving scrollback. |

## Approach

Reuse the PTY layer the agent sign-in already uses: `PtySessionManager`
(`src-tauri/src/pty_session.rs`), `send_input` / `resize_session` in `lib.rs`,
`PtyOutputStore` (`src/lib/pty-output-store.ts`) and `TerminalView`
(`src/components/TerminalView.tsx`). Workspace terminals add an id prefix, `shell-`, and their
own event, `workspace-terminal`. A second, separate PTY manager was considered and rejected: it
would duplicate the spawn, writer-thread and kill code for no isolation that the prefix does not
already give.

## Backend

New module `src-tauri/src/workspace_terminal.rs`.

- `workspace_terminal_open(path: String) -> Result<String, String>`, `#[tauri::command(async)]`:
  1. `files::ensure_known_workspace(&path, |p| store.is_known_workspace(p))`. A session's
     worktree passes, because session folders are known workspaces (`workspaces_in` in
     `store.rs`); a draft's picked folder passes through recent folders.
  2. Pick the shell: `SHELL` from `env_resolver::cached_user_env()`, if it is an absolute path to
     an executable file; else `/bin/zsh`.
  3. Make a fresh id in the backend: `shell-<n>` from a process-wide `AtomicU64` counter. The
     id needs no randomness, because only ids the manager holds reach a PTY. That means no new
     dependency.
  4. `PtySessionManager::start_session(id, canonical_path, shell, ["-l"], [])`, through a
     helper `start_shell(manager, id, folder, shell)` that tests can call with an explicit
     shell.
  5. Return the id.
- `workspace_terminal_close(id: String) -> Result<(), String>`: accepts only an id with the
  `shell-` prefix, then `PtySessionManager::kill_session`. A shell that exited by itself has
  already left the manager (its reader thread removes it), so `kill_session`'s "not found" is
  mapped to success here.
- `is_workspace_terminal_id(id) -> bool`, the same shape as `is_sign_in_terminal_id`: prefix
  plus a bounded `[A-Za-z0-9]` suffix.
- **Input and resize** stay on `send_input` and `resize_session`. They only reach ids that exist
  in the manager, and only the backend creates ids. `send_input` stays sync, so keystrokes keep
  their order (see the comment above it).
- **Events.** The PTY callback in `lib.rs` already routes `signin-` ids to `sign-in-terminal`.
  It also routes `shell-` ids to `workspace-terminal`, with payload
  `{ terminalId, kind: "output", data }` or `{ terminalId, kind: "exit", exitCode }`. The
  sign-in routing does not change.
- **Quit.** `lib.rs` ends with `.run(generate_context!())`, and nothing kills PTYs when the app
  quits. A shell usually dies of SIGHUP when its PTY closes, but a `nohup`ed or disowned job
  would outlive Zorvo. Change it to `.build(ctx)` plus `.run(|app, event| …)`, which calls
  `PtySessionManager::kill_all` on `RunEvent::Exit`. That also covers sign-in terminals, which
  is right.
- **Privacy.** Nothing logs what goes into or comes out of a shell.

## Frontend

- **`src/hooks/useWorkspaceTerminals.ts`** owns, in the main window:
  - the tabs, keyed by the folder's canonical path: `{ id, folderPath, label, status: "live" | "exited" }`;
  - one `PtyOutputStore`, fed by `workspace-terminal` output events.

  Because the store outlives the drawer, a tab shown again replays its scrollback through
  `TerminalView`, which already replays a snapshot and then follows new output. Its API is
  `tabsFor(folder)`, `open(folder)`, `close(id)`, `closeFolder(folder)` and `send` / `resize`.
  Events for an id the hook no longer holds (the exit that follows a close) are ignored, and
  `close` forgets the id's output in the store.
- **Labels.** Worked out at render, not stored: the folder name, plus the folder's current branch
  for a repository (`zorvo · main`), so a `git switch` typed in the shell shows in the label. A
  tab keeps its number among the folder's tabs: `zorvo · main 2`.
- **`src/components/terminal/TerminalDrawer.tsx`.** Along the bottom of the content area,
  under both the chat column and the right panel, with:
  - a resize handle on its top edge: drag it, or use arrow up and down when it has focus, with
    `aria-orientation="horizontal"`, `role="separator"` and `focus-ring`. The height starts at
    280 px, stays between 120 px and 70% of the window, and is not saved;
  - the tab bar: each tab is a button with a close **×**, then **+** (`aria-label="New terminal"`)
    and a hide button;
  - the active tab's `TerminalView`.

  **Focus.** `TerminalView` focuses its terminal whenever it mounts, which would take focus from
  the composer every time you switch sessions with the drawer open. It gets an `autoFocus` prop,
  so the terminal takes focus only when you open the drawer, add a tab or pick one, never on a
  session switch.

  When a shell exits, its tab shows "The shell exited." and a **Start a new shell** button,
  which opens a fresh tab in the same folder. The terminal stays dark in both themes
  (`bg-terminal-bg`).
- **Top bar.** A terminal button (lucide `SquareTerminal`) with `aria-pressed`, shown when the
  view has a folder. Opening the drawer on a folder without tabs opens one.
- **Deleting a worktree session.** `removeSessionWorktree` (`src/lib/session-worktree.ts`) takes
  an `onRemoving` callback, and `useSessionActions.deleteSession` passes `closeFolder` for the
  worktree's path. It runs right before `remove_session_worktree`, so a worktree another session
  still uses, or one kept because its agent would not stop, keeps its shells.
- **`App.tsx`** gets a hook call, a prop to `TopBar` and the drawer's mount; the logic stays in
  the hook.

## Docs

- `CHANGELOG.md`: a line under `Unreleased` → `Added`.
- `CLAUDE.md`: "What this is" says a PTY is used only for an agent's terminal sign-in. That
  changes, so add a **Workspace terminal** paragraph to Architecture (ids, event, lifetime, the
  rule that the UI sends only a folder).
- `README.md`: the feature list.

## Risks accepted

- The terminal is a full shell. Script injected into the webview could open one and type into
  it. Today the CSP allows only bundled script, the same guard the sign-in terminal relies on.
  The UI still never sends a command, and the backend accepts only ids it made.
- xterm 6 breaks under esbuild's syntax minifier. `vite.config.ts` keeps `minifySyntax: false`
  (guarded by `xterm-release-build.test.ts`), and the feature is checked in a release build too.

## Testing

Rust (`src-tauri/tests/workspace_terminal_test.rs`, and unit tests in the module):

- an unknown folder is refused before anything starts;
- a shell starts in the given folder: through `start_shell` with `/bin/sh` (no user dotfiles),
  write `pwd` and read the folder back from its output. CI runs Rust on `macos-latest`;
- close ends the process, closing a shell that already exited succeeds, and ids from the counter
  never repeat;
- `RunEvent::Exit` ends every PTY: the handler calls one `kill_all` function, which is tested
  directly;
- close and the id check refuse an id without the `shell-` prefix, and a `signin-` id;
- the shell falls back to `/bin/zsh` when `SHELL` is missing or not an executable path;
- the PTY event routing sends `shell-` ids to `workspace-terminal` and `signin-` ids to
  `sign-in-terminal`.

Vitest:

- `useWorkspaceTerminals` opens a terminal for the worktree of a worktree session, and for the
  workspace otherwise;
- output events append to the right tab, and an exit marks it exited;
- close calls `workspace_terminal_close`;
- switching sessions shows the other folder's tabs, and coming back keeps the first terminal and
  its output;
- the top-bar button toggles the drawer, and its button is absent without a folder;
- deleting a worktree session closes its terminals;
- Escape typed in the terminal does not close the drawer;
- switching sessions with the drawer open leaves focus where it was, while opening the drawer
  focuses the terminal;
- a tab's label follows the folder's current branch.

Manual, in `pnpm tauri dev` and in a release build (`pnpm tauri build`):

- run `pnpm dev` in one tab and `git status` in another;
- switch sessions and back;
- type `exit` and start a new shell;
- quit Zorvo with a `nohup sleep 300 &` running, and check that it is gone.
