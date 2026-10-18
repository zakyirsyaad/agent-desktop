# Diff view and background tasks — design

Date: 2026-10-18
Branch: `feat/diff-view-background-tasks`
Builds on: `docs/design-system/` (tokens, `Button`, `IconButton`, `focus-ring`)

## Goal

Two things Claude Code desktop has and Zorvo lacks:

1. A compact diff-stat summary (`± +2,847 −35`) that opens a full diff view
   of the session's repository.
2. A "Background tasks" control that lists what is running right now
   (agents working, terminal sessions, shell commands and dev servers that
   agents started), how long each has run, and lets the user open or stop it.

## Constraints

- Only design-system tokens; `src/test/design-tokens.test.ts` rejects raw
  palette colors and hex values. Added lines use `status-running` on
  `diff-added`, removed lines `danger` on `diff-removed`.
- `Button` / `IconButton` primitives and the `focus-ring` utility.
- Light and dark modes both work.
- No keyboard shortcuts (the user declined them). Escape and click-outside
  dismissal of a popover (`useDismiss`) are not shortcuts and stay.
- Test-first. `npx vitest run`, `npx tsc --noEmit` and `cargo test` green.
- Source files stay under 800 lines; `App.tsx` (717) gets its new wiring
  through hooks.

## Part 1 — Diff-stat summary and diff view

### Diff targets

The view compares the working tree with one of two bases:

| Target id | Label in header        | Base                         |
|-----------|------------------------|------------------------------|
| `head`    | `HEAD → working tree`  | `HEAD` (empty tree if none)  |
| `base`    | `main → working tree`  | `merge-base(<base>, HEAD)`   |

`<base>` is the repository's default branch: the target of
`refs/remotes/origin/HEAD` when set, else local `main`, else `master`.
The `base` target is offered only when such a branch exists, HEAD exists,
and the current branch is not the base branch itself. The label shows the
branch's short name (`main`, `master`, `develop`…).

The default target is `base` when offered, else `head`. The chip in the
TopBar and in the Changes panel always shows the **`head`** totals (what is
uncommitted), so it matches the Changes list; the diff view's numbers follow
the target picked in its dropdown.

### Backend (`src-tauri/src/changes.rs`, split if it passes ~600 lines)

- `session_diff_targets(path) -> DiffTargets`
  `{ base: Option<{ name: String }> }` (`head` is always available).
- `session_diff_stats(path, target) -> Vec<FileStat>`
  `FileStat { path, oldPath, kind, added, removed, isBinary }`.
  - Tracked changes: `git diff --numstat -z -M <base>` joined with the kind
    from `git diff --name-status -z -M <base>`. A `-\t-` numstat line is a
    binary file (`added = removed = 0`, `isBinary = true`).
  - Untracked files (from the existing status listing): read only when the
    path resolves inside the repository and is not a symlink; count `\n`
    (plus one for a last line without one); a NUL byte in the first 8 KiB
    marks it binary; files over 2 MiB are counted by streaming, never loaded
    whole. A symlink counts as one added line.
- `session_file_diff(path, file, target?)` gains an optional `target`
  (default `head`). For `base` it diffs against the merge-base. The existing
  rule stays: the file must be in that target's change list, otherwise the
  call is refused.

### Frontend

- `src/lib/diff-stats.ts` — `FileStat` type, `totalsOf(stats)`,
  `formatLineCount(n)` (`2847 → "2,847"`, `en-US` grouping), and the minus
  sign constant `−` (U+2212).
- `src/lib/git-changes.ts` — `UnifiedRow` gains optional `oldLine` and
  `newLine`, parsed from each `@@ -a,b +c,d @@` header: context rows carry
  both, removed rows `oldLine`, added rows `newLine`. Existing callers keep
  working.
- `src/hooks/useDiffStats.ts` — reads `session_diff_stats` for a path and
  target; reads again whenever the Changes `version` goes up (turn ended,
  window focus, refresh). Errors are reported once per folder, like
  `useSessionChanges`.
- `src/components/changes/DiffStatChip.tsx` — a button: diff icon, `+N` in
  `text-status-running`, `−M` in `text-danger`, `tabular-nums`. Accessible
  name "2,847 lines added, 35 removed. Open the diff". Hidden when both are 0
  or stats are not loaded.
- `src/components/changes/DiffRows.tsx` — the shared row renderer: old and
  new line-number gutters (`text-fg-subtle`, not selectable), a `+`/`−`
  gutter, and the row backgrounds. `FileDiff` (in the Changes panel) switches
  to it, so the panel also gets line numbers.
- `src/components/changes/DiffFileSection.tsx` — one collapsible file:
  chevron, file icon, file name (`text-fg-secondary`) with its folder dimmed
  (`text-fg-subtle`), and `+N −M`; a rename shows `old → new` as tooltip.
  The body loads `session_file_diff` the first time it opens, then again on
  each `version` while open. Binary files say "Binary file".
- `src/components/changes/DiffView.tsx` — the pane:
  - **Header:** the target dropdown (`main → working tree` /
    `HEAD → working tree`; with no `base` it is plain text), a search toggle
    whose input filters files by path (case-insensitive substring), a ⋯ menu
    (Expand all, Collapse all, Refresh), an expand/restore button, and close.
  - **Body:** one `DiffFileSection` per file, sorted by path. With 25 files
    or fewer every section starts open; above that all start closed.
  - **Empty / loading / error** states in `text-fg-subtle` / `text-danger`.
  - **Width:** a right pane `w-1/2 min-w-[480px]` next to the chat; expanded
    it takes the whole area right of the sidebar. It replaces the Changes or
    Files side panel while open (only one right pane at a time, via
    `useSidePanel`).
- `TopBar`: the Changes button keeps toggling the Changes panel, but its
  file-count badge is replaced by a separate `DiffStatChip` button right next
  to it, which opens the diff view. The Changes panel header shows the same
  chip.

## Part 2 — Background tasks

### What is observable

| Kind       | Source                                     | Open            | Stop                          |
|------------|--------------------------------------------|-----------------|-------------------------------|
| `agent`    | ACP session busy in a turn (`isBusy`)      | its session     | `acp_cancel` (ends the turn)  |
| `terminal` | PTY session with `status === "running"`    | its session     | `terminate_session`           |
| `process`  | process scan (below)                       | owning session  | `stop_background_process`     |

Running `execute` tool calls are **not** a separate source: the shell that
runs them shows up in the process scan, which can stop that one command
without cancelling the turn, and also sees commands the agent sent to the
background (dev servers) after the tool call finished.

### Backend (`src-tauri/src/background_processes.rs`, new)

- `AcpManager::root_pids()` and `PtySessionManager::root_pids()` return
  `Vec<(app_session_id, pid)>` for live sessions.
- Process table: `ps -axo pid=,ppid=,etime=,command=` run directly (no
  shell, fixed arguments), parsed into rows. `etime` (`[[dd-]hh:]mm:ss`) is
  parsed into seconds.
- Task selection: walk descendants of each root pid; a **task** is a shell
  process (`sh`, `bash`, `zsh`, `dash`, `fish`, matched on the executable's
  base name, login `-zsh` included) with no other shell between it and the
  root. The agent itself and non-shell children (MCP servers, helpers) are
  not listed.
- `background_processes() -> Vec<BackgroundProcess>`
  `{ pid, sessionId, command, elapsedSecs, ports: Vec<u16> }`. `command` is
  the innermost meaningful command: the argument after `-c` with known
  wrappers stripped (`source … && `, `eval '…'`), falling back to the raw
  command line; at most 300 characters. `ports` come from
  `lsof -nP -a -p <task and descendant pids> -iTCP -sTCP:LISTEN -Fpn`
  (empty when lsof fails or is missing).
- `stop_background_process(pid)`: rescans; refuses unless `pid` is one of the
  tasks just reported. Sends `SIGTERM` (via `/bin/kill`) to the task's whole
  subtree, deepest first; after 2 s sends `SIGKILL` to any still alive.
  Returns once `SIGTERM` is sent.

### Frontend

- `src/lib/background-tasks.ts` (pure): `BackgroundTask { id, kind, name,
  detail?, status, startedAt, sessionId }` and `backgroundTasksOf(sessions,
  isBusy, busySince, needsApproval, processes, now)`:
  - `agent`: name = session name; status `Working` or `Needs approval`;
    `startedAt` = when the turn began.
  - `terminal`: name = session name; status `Running`; `startedAt` =
    `createdAt`.
  - `process`: name = command; detail = owning session name and
    `localhost:<port>` labels; status `Running`; `startedAt` =
    `now − elapsedSecs`.
  - Sorted by `startedAt`, oldest first.
  - `formatElapsed(ms)`: `45s`, `2m 13s`, `1h 04m`.
- `useAcpSessions` records `busySince` per session (set on prompt, cleared at
  turn end).
- `src/hooks/useBackgroundProcesses.ts`: polls `background_processes` every
  5 s while any agent or terminal session is alive, every 2 s while the
  popover is open, never otherwise. Overlapping reads keep only the latest.
- `src/hooks/useBackgroundTasks.ts`: combines the sources and exposes
  `tasks`, `open(task)` (selects the owning session) and `stop(task)`
  (dispatches by kind; a failure is reported through the app's error toast).
- `src/components/topbar/BackgroundTasksMenu.tsx`: an `IconButton` in the
  TopBar's right group with a count badge when tasks > 0, opening a popover
  (`useDismiss`). Each row: kind icon, name (truncated, full text as
  tooltip), detail, status, a live duration (a 1 s tick only while open), an
  Open button and a Stop button. Stop shows "Stopping…" until the task is
  gone from the next read. Empty: "Nothing running."

## Testing

- **Rust:** `ps` line parsing, `etime` parsing, top-shell selection over a
  fixture tree, command unwrapping, stop refusal for a pid outside the task
  set; `numstat` / `name-status` parsing, untracked line counting (text,
  binary, no trailing newline), target resolution and stats in a temporary
  git repository with a `main` branch and a feature branch.
- **Vitest:** `diff-stats` formatting and totals; `unifiedDiffRows` line
  numbers; `DiffStatChip`; `DiffView` (target switch re-reads, search filter,
  collapse/expand all, expand and close, auto-open threshold); TopBar wiring;
  `backgroundTasksOf` and `formatElapsed`; `useBackgroundProcesses` polling
  intervals; `BackgroundTasksMenu` (rows, open, stop, empty state).

## Out of scope

- Searching inside diff contents, side-by-side diff, staging hunks.
- Stopping an agent's MCP servers or the agent process from the menu (Stop on
  an `agent` row cancels the turn; ending the session stays where it is).
- Windows/Linux process scanning (Zorvo is macOS-only today; the scan
  returns an empty list elsewhere).
