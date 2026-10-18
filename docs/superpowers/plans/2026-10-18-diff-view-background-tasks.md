# Diff View and Background Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `± +N −M` diff-stat chip that opens a full diff view, and a TopBar "Background tasks" popover listing running agents, terminals and agent-started shell processes with Open and Stop.

**Architecture:** Rust gains diff-stat/target commands in a new `diff_stats.rs` (beside `changes.rs`) and a process scanner in `background_processes.rs`. The UI adds pure libs (`diff-stats.ts`, `background-tasks.ts`), data hooks, and presentational components under `components/changes/` and `components/topbar/`; `App.tsx` only wires hooks to props.

**Tech Stack:** Tauri 2 (Rust, `std::process::Command`), React 19, Tailwind 4 tokens, Vitest + Testing Library, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-10-18-diff-view-background-tasks-design.md`

## Global Constraints

- Colors only from design-system tokens (`src/styles/globals.css`); `src/test/design-tokens.test.ts` must stay green. Added = `text-status-running` / `bg-diff-added`; removed = `text-danger` / `bg-diff-removed`.
- Buttons through `src/components/ui/Button.tsx` / `IconButton.tsx`; interactive elements carry `focus-ring`.
- No keyboard shortcuts. Escape/click-outside via `useDismiss` is allowed.
- Minus sign in UI copy is `−` (U+2212). Numbers use `en-US` grouping (`2,847`).
- Source files < 800 lines. `App.tsx` (717 now) only gains wiring.
- Tests mock Tauri via `vi.spyOn(window.__TAURI_INTERNALS__, "invoke")` as in `src/test/changes-panel.test.tsx`.
- Rust integration tests live in `src-tauri/tests/*.rs` and import `zorvo_lib::…`; temp repos as in `src-tauri/tests/changes_test.rs` (`repo(tag)` helper, branch `main`).
- Commit after each task; stage explicit paths only (never `git add -A`). Commit types: `feat:`, `test:`, `refactor:`.
- Gates at the end: `npx vitest run`, `npx tsc --noEmit`, `cargo test` (in `src-tauri`).

## Review Focus

1. **File names with spaces, tabs or non-ASCII** in numstat output — parsing must use `-z` so `my file.ts` and `ü.ts` get the right counts (test in Task 1).
2. **A repository with no commits yet** — `head` stats must work against the empty tree and `base` must not be offered (test in Task 1).
3. **A detached HEAD or a branch with no merge-base with `main`** — `base` is not offered instead of erroring (test in Task 1).
4. **A task process that exits between the list and Stop** — Stop must return a clear "is no longer running" error, never signal a reused pid outside the task set (test in Task 6).
5. **Agent commands with quotes/newlines** (`zsh -c "source …; eval 'npm run dev'"`) — the shown name is the inner command, capped at 300 chars (test in Task 6).

---

### Task 1: Rust diff targets and per-file line stats

**Files:**
- Create: `src-tauri/src/diff_stats.rs`
- Modify: `src-tauri/src/changes.rs` (make `toplevel_of`, `run_git`, `run_git_with`, `changes_at`, `diff_base`, `resolves_inside` `pub(crate)`; extend `file_diff` with a target), `src-tauri/src/lib.rs` (`pub mod diff_stats;`, register commands)
- Test: `src-tauri/tests/diff_stats_test.rs`, `src-tauri/tests/changes_test.rs` (target param)

**Interfaces:**
- Produces (Rust, `zorvo_lib::diff_stats`):
  - `#[serde(rename_all = "lowercase")] pub enum DiffTarget { Head, Base }`
  - `pub struct BaseBranch { pub name: String }` (camelCase serde)
  - `pub struct DiffTargets { pub base: Option<BaseBranch> }`
  - `pub struct FileStat { pub path: String, pub old_path: Option<String>, pub kind: ChangeKind, pub added: u64, pub removed: u64, pub is_binary: bool }` (camelCase serde)
  - `pub fn diff_targets(git: &Path, dir: &Path) -> Result<DiffTargets, String>`
  - `pub fn diff_stats(git: &Path, dir: &Path, target: DiffTarget) -> Result<Vec<FileStat>, String>` (sorted by path)
  - `pub fn base_commit(git: &Path, toplevel: &Path, target: DiffTarget) -> Result<String, String>` (HEAD/empty tree, or merge-base)
- Produces (changes.rs): `pub fn file_diff(git, dir, path, target: DiffTarget)`; existing callers/tests pass `DiffTarget::Head`.
- Tauri commands: `session_diff_targets(path) -> DiffTargets`, `session_diff_stats(path, target) -> Vec<FileStat>`, `session_file_diff(path, file, target: Option<DiffTarget>)`. All call `ensure_known_workspace` first, like `session_changes`.

- [ ] **Step 1: Write the failing tests** in `src-tauri/tests/diff_stats_test.rs` (copy the `git`/`repo` helpers from `changes_test.rs`):
  - `counts_added_and_removed_lines_per_file_against_head`: edit `src/app.ts` to `"one\nTWO\nthree\nfour\n"` → stat `{path:"src/app.ts", kind:Modified, added:2, removed:1}`; delete `gone.txt` → `added:0, removed:1, kind:Deleted`.
  - `counts_untracked_files_whole`: write `new.md` = `"a\nb\nc"` (no trailing newline) → `added:3, removed:0, kind:Untracked`; write `bin.dat` = `[0u8, 1, 2]` → `is_binary:true, added:0`.
  - `reads_paths_with_spaces_and_unicode`: commit `my file.ts` and `ü.ts`, change both → both paths exact.
  - `offers_main_as_base_only_on_another_branch`: on `main` → `base == None`; `git checkout -q -b feat`, commit a change to `src/app.ts`, then modify `old.md` uncommitted → `diff_targets.base == Some(BaseBranch{name:"main"})`; `diff_stats(Base)` contains both `src/app.ts` and `old.md`; `diff_stats(Head)` contains only `old.md`.
  - `prefers_origin_head_for_the_base_name`: `git branch develop`, `git update-ref refs/remotes/origin/develop develop`, `git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/develop`, checkout `feat` → base name `"develop"`.
  - `offers_no_base_before_the_first_commit_or_when_detached`: fresh `git init` repo with an untracked file → `base == None` and `diff_stats(Head)` lists the file; in `repo()` run `git checkout -q --detach` → `base == None`.
  - In `changes_test.rs`: `diffs_against_the_merge_base_for_the_base_target`: on `feat` with a committed change → `file_diff(.., "src/app.ts", DiffTarget::Base)` contains `+TWO`; `file_diff(.., DiffTarget::Head)` errors with "is not a changed file".
- [ ] **Step 2: Run** `cd src-tauri && cargo test --test diff_stats_test --test changes_test` → FAIL (module missing).
- [ ] **Step 3: Implement `diff_stats.rs`.** Base branch: `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` → strip `origin/`; else first of `main`, `master` that `rev-parse --verify --quiet refs/heads/<n>` finds. Offer it only when HEAD exists, `git symbolic-ref --quiet --short HEAD` succeeds (not detached) and differs from the name, and `merge-base <name> HEAD` succeeds. Tracked stats: `git diff --numstat -z -M <base>` (rename records are `added\tremoved\t\0old\0new\0`; `-\t-` = binary) joined with `git diff --name-status -z -M <base>` for the kind (`R…` → Renamed with `old_path`). Untracked: from `changes_at` (head) or `git ls-files --others --exclude-standard -z` (base); count lines by streaming the file in 64 KiB chunks (count `\n`, +1 if the last byte is not `\n` and the file is non-empty); a NUL in the first 8 KiB → binary; a symlink → `added: 1`; skip files where `resolves_inside` is false.
- [ ] **Step 4: Extend `file_diff`** with `target`: tracked diff uses `base_commit(target)`; the "is a changed file" check uses the target's list (for `Base`, the paths from `diff_stats(Base)`).
- [ ] **Step 5: Run** the same `cargo test` command → PASS; then `cargo test` (all) → PASS.
- [ ] **Step 6: Commit** `feat: diff targets and per-file line stats in the backend` (stage the five files above).

### Task 2: Diff libs — totals, formatting, line numbers

**Files:**
- Create: `src/lib/diff-stats.ts`
- Modify: `src/lib/git-changes.ts`
- Test: `src/test/diff-stats.test.ts`, `src/test/git-changes.test.ts`

**Interfaces:**
- Produces:
  - `export type DiffTargetId = 'head' | 'base'`
  - `export interface DiffTargets { base: { name: string } | null }`
  - `export interface FileStat extends FileChange { added: number; removed: number; isBinary: boolean }`
  - `export const MINUS = '−'`
  - `export function totalsOf(stats: readonly FileStat[]): { added: number; removed: number }`
  - `export function formatLineCount(n: number): string`
  - `export function targetLabel(target: DiffTargetId, targets: DiffTargets): string` → `"main → working tree"` / `"HEAD → working tree"`
  - `UnifiedRow` gains `oldLine?: number; newLine?: number`.

- [ ] **Step 1: Write failing tests.** `formatLineCount(2847) === "2,847"`, `formatLineCount(0) === "0"`; `totalsOf([{added:2,removed:1},{added:2845,removed:34}])` → `{added:2847, removed:35}`; `targetLabel('base', {base:{name:'main'}}) === "main → working tree"`, `targetLabel('head', …) === "HEAD → working tree"`. In `git-changes.test.ts`: for `"@@ -10,3 +10,4 @@\n ctx\n-old\n+new\n+more\n ctx2\n"` the rows are hunk (no numbers), `{context, oldLine:10, newLine:10}`, `{removed, oldLine:11}`, `{added, newLine:11}`, `{added, newLine:12}`, `{context, oldLine:12, newLine:13}`; a hunk header `@@ -0,0 +1 @@` (count omitted) starts new lines at 1.
- [ ] **Step 2: Run** `npx vitest run src/test/diff-stats.test.ts src/test/git-changes.test.ts` → FAIL.
- [ ] **Step 3: Implement** both; line numbers parsed with `/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/`, counters advanced per row kind; note rows get no numbers.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: diff totals, count formatting and diff line numbers`.

### Task 3: Shared diff rows, file section, and chip

**Files:**
- Create: `src/components/changes/DiffRows.tsx`, `src/components/changes/DiffFileSection.tsx`, `src/components/changes/DiffStatChip.tsx`
- Modify: `src/components/changes/FileDiff.tsx` (render through `DiffRows`, pass `target` through, default `'head'`)
- Test: `src/test/diff-view.test.tsx` (sections and chip), `src/test/changes-panel.test.tsx` (still green)

**Interfaces:**
- Consumes: Task 2 types; `session_file_diff` with `{ path, file, target }`.
- Produces:
  - `DiffRows({ rows, label }: { rows: UnifiedRow[]; label: string })` — `aria-label={label}`, each row `data-line={kind}`.
  - `DiffStatChip({ added, removed, onOpen }: { added: number; removed: number; onOpen: () => void })` — renders nothing when both are 0.
  - `DiffFileSection({ rootPath, stat, target, version, isOpen, onToggle })` with `stat: FileStat`, `target: DiffTargetId`, `isOpen: boolean`, `onToggle: () => void`.
  - `FileDiff` props gain optional `target?: DiffTargetId`.

- [ ] **Step 1: Write failing tests.**
  - Chip: `render(<DiffStatChip added={2847} removed={35} onOpen={fn}/>)` → button named `"2,847 lines added, 35 removed. Open the diff"` showing `+2,847` and `−35`; click calls `onOpen`; with `0, 0` the container is empty.
  - Section: given `stat {path:"src/lib/app.ts", added:3, removed:1}` closed → header button `aria-expanded="false"`, shows `app.ts`, `src/lib`, `+3`, `−1`, no invoke; click → `invoke("session_file_diff", {path:"/w", file:"src/lib/app.ts", target:"base"})` and rows render with line numbers `10` and `11` visible; `isBinary` stat → "Binary file" and no invoke.
- [ ] **Step 2: Run** `npx vitest run src/test/diff-view.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** `DiffRows` gutters: two `w-10 text-right text-fg-subtle select-none tabular-nums` cells, a sign cell (`+` / `−`), then text; reuse `ROW_STYLE` moved here from `FileDiff`. Section lazy-loads on first open and re-reads when `version` changes while open (same cancellation pattern as `FileDiff`).
- [ ] **Step 4: Run** `npx vitest run src/test/diff-view.test.tsx src/test/changes-panel.test.tsx` → PASS.
- [ ] **Step 5: Commit** `feat: diff rows with line numbers, file sections and the diff-stat chip`.

### Task 4: DiffView pane and its data hook

**Files:**
- Create: `src/hooks/useDiffStats.ts`, `src/components/changes/DiffView.tsx`, `src/components/changes/DiffViewHeader.tsx`
- Test: `src/test/diff-view.test.tsx` (pane), `src/test/use-diff-stats.test.tsx`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces:
  - `useDiffTargets(path: string | undefined, isRepository: boolean, version: number): DiffTargets` (`{base:null}` until read)
  - `useDiffStats(path: string | undefined, isRepository: boolean, target: DiffTargetId, version: number, onError: (m: string) => void): { stats: FileStat[] | null; reload: () => void }` — same latest-read/cancel/report-once pattern as `useSessionChanges`.
  - `DiffView({ rootPath, version, isExpanded, onToggleExpanded, onClose, onError })` — owns target (default `'base'` when `targets.base`, else `'head'`), search text, and open sections.

- [ ] **Step 1: Write failing tests.**
  - Hook: invokes `session_diff_stats` with `{path:"/w", target:"head"}`; re-invokes when `version` goes 1→2 and when target changes; a rejected read calls `onError` once with a message containing `/w`.
  - Pane (invoke mock answering `session_diff_targets` → `{base:{name:"main"}}`, `session_diff_stats` → 3 stats): header shows `"main → working tree"`; choosing `HEAD → working tree` in the target dropdown re-invokes stats with `target:"head"`; typing `app` in the search input (after clicking "Search files") leaves only paths containing `app`; ⋯ → "Collapse all" makes every section `aria-expanded="false"`, "Expand all" the reverse; "Refresh" re-invokes stats; the expand button calls `onToggleExpanded`, close calls `onClose`; with 26 stats every section starts collapsed, with 3 all start expanded; with `{base:null}` the header shows plain text `"HEAD → working tree"` and no dropdown; zero stats → "No changes against HEAD." / "No changes against main.".
- [ ] **Step 2: Run** `npx vitest run src/test/diff-view.test.tsx src/test/use-diff-stats.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Pane: `aside aria-label="Diff view"`, `flex h-full flex-col border-l border-border bg-surface-1`, width `w-1/2 min-w-[480px] shrink-0` or `flex-1` when expanded. Target dropdown and ⋯ menu are small popovers using `useDismiss`; header icons are `IconButton`s (`Search`, `MoreHorizontal`, `Maximize2`/`Minimize2`, `X` from lucide-react).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: diff view pane with targets, search and section controls`.

### Task 5: Wire the chip and diff view into TopBar, Changes panel and App

**Files:**
- Modify: `src/hooks/useSidePanel.ts` (`SidePanel = 'files' | 'changes' | 'diff'`; add `headStats` from `useDiffStats(…, 'head', changes.version, onError)`), `src/components/TopBar.tsx` (replace `changeCount` badge with `diffStats?: {added:number; removed:number}` and `onOpenDiff?: () => void` rendering `DiffStatChip` next to the Changes button), `src/components/changes/ChangesPanel.tsx` (optional `diffStats` + `onOpenDiff` → chip under the header), `src/App.tsx` (render `DiffView` when `sidePanel.open === 'diff'`; local `isDiffExpanded` state; when expanded hide the chat `article`)
- Test: `src/test/top-bar.test.tsx`, `src/test/changes-panel.test.tsx`, `src/test/chrome-wiring.test.tsx`

**Interfaces:**
- Consumes: `totalsOf`, `DiffStatChip`, `DiffView`, `useDiffStats`.
- Produces: `SidePanelState.headStats: FileStat[] | null`; `TopBarProps.diffStats`, `TopBarProps.onOpenDiff`; `ChangesPanelProps.diffStats`, `ChangesPanelProps.onOpenDiff`.

- [ ] **Step 1: Write failing tests.** TopBar with `diffStats={{added:2847, removed:35}}` shows the chip button and the Changes toggle no longer shows a count; clicking the chip calls `onOpenDiff`, clicking the GitCompare toggle still calls `onToggleChanges`. ChangesPanel with `diffStats` shows the chip. In `chrome-wiring.test.tsx` (App-level): with stats mocked, clicking the chip renders `aside "Diff view"` and hides `"Changes panel"`; close returns to no side panel.
- [ ] **Step 2: Run** `npx vitest run src/test/top-bar.test.tsx src/test/changes-panel.test.tsx src/test/chrome-wiring.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the wiring. `changeCount` prop is removed from TopBar and its call site.
- [ ] **Step 4: Run** the three files → PASS; `wc -l src/App.tsx` < 800.
- [ ] **Step 5: Commit** `feat: open the diff view from the diff-stat chip`.

### Task 6: Rust process scanner and stop

**Files:**
- Create: `src-tauri/src/background_processes.rs`
- Modify: `src-tauri/src/acp/manager.rs` (`pub fn root_pids(&self) -> Vec<(String, u32)>`), `src-tauri/src/acp/connection.rs` (`pub fn pid(&self) -> Option<u32>`), `src-tauri/src/pty_session.rs` (`pub fn root_pids(&self) -> Vec<(String, u32)>` via `child.process_id()`), `src-tauri/src/lib.rs` (module + two commands)
- Test: `src-tauri/tests/background_processes_test.rs`

**Interfaces:**
- Produces (`zorvo_lib::background_processes`):
  - `pub struct ProcessRow { pub pid: u32, pub ppid: u32, pub elapsed_secs: u64, pub command: String }`
  - `pub fn parse_ps(output: &str) -> Vec<ProcessRow>`
  - `pub fn parse_etime(value: &str) -> Option<u64>`
  - `pub fn select_tasks(rows: &[ProcessRow], roots: &[(String, u32)]) -> Vec<TaskProcess>` where `TaskProcess { pid, session_id: String, command: String, elapsed_secs: u64, subtree: Vec<u32> }` (`subtree` deepest-first, task pid last)
  - `pub fn display_command(raw: &str) -> String`
  - `pub fn parse_lsof_ports(output: &str) -> HashMap<u32, Vec<u16>>`
  - `#[serde(rename_all = "camelCase")] pub struct BackgroundProcess { pub pid: u32, pub session_id: String, pub command: String, pub elapsed_secs: u64, pub ports: Vec<u16> }`
  - `pub fn scan(roots: &[(String, u32)]) -> Result<Vec<BackgroundProcess>, String>` and `pub fn stop(roots: &[(String, u32)], pid: u32) -> Result<(), String>`
  - Tauri commands `background_processes(pty, acp) -> Vec<BackgroundProcess>` and `stop_background_process(pty, acp, pid: u32)`; roots = `pty.root_pids()` ++ `acp.root_pids()`.

- [ ] **Step 1: Write failing tests.**
  - `parse_etime("05:07") == Some(307)`, `"1:02:03"` → 3723, `"2-01:00:00"` → 176400, `"x"` → None.
  - `parse_ps` on `"  10     1   01:00 /usr/bin/agent --acp\n  11    10   00:30 /bin/zsh -c npm run dev\n"` → two rows with those fields.
  - `select_tasks`: tree root 10 (agent) → 11 `/bin/zsh -c npm run dev` → 12 `npm run dev` → 13 `node vite`; 10 → 20 `node mcp-server.js`; 10 → 30 `-zsh` → 31 `bash -c ls` → result is exactly pids `[11, 30]` (31 is under a shell), session `"s1"`, `subtree` of 11 == `[13, 12, 11]`; a process not under any root is never listed.
  - `display_command`: `/bin/zsh -c 'source /tmp/snap.sh && eval '"'"'npm run dev'"'"''` style input (use the literal string Claude Code produces: `/bin/zsh -c -l source /Users/x/.claude/shell-snapshots/snap.sh && eval 'npm run dev' \< /dev/null && pwd -P >| /tmp/cwd`) → `"npm run dev"`; `bash -c "pnpm test"` → `"pnpm test"`; a 500-char command → 300 chars ending in `…`.
  - `parse_lsof_ports("p11\nn*:5173\np13\nn127.0.0.1:3000\n")` → `{11:[5173], 13:[3000]}`.
  - `stop` with a pid not among `select_tasks` of a live scan → `Err` containing `"is no longer running"`; with a real tree: spawn the root `Command::new("/bin/sh").args(["-c", "/bin/sh -c 'sleep 30; :' & wait"])` (the inner shell is the task; `; :` keeps it from exec-ing into `sleep`), wait until `scan` lists it, then `stop(&[("s1".into(), root_pid)], task_pid)` → Ok, and within 3 s both the task and its `sleep` are gone (`kill -0` fails).
- [ ] **Step 2: Run** `cd src-tauri && cargo test --test background_processes_test` → FAIL.
- [ ] **Step 3: Implement.** `ps` via `Command::new("/bin/ps").args(["-axo","pid=,ppid=,etime=,command="])`; shells = base name (leading `-` stripped) in `["sh","bash","zsh","dash","fish"]`; a task is a shell descendant of a root whose path to the root has no other shell. `display_command`: take the text after the first `-c` (skipping `-l`/`-i` flags); if it contains `eval '…'`, take the eval argument (undo `'"'"'` escaping); cut at ` \< /dev/null` / ` && pwd -P`; trim quotes; cap 300 chars with `…`. Ports: `/usr/sbin/lsof -nP -a -p <comma pids> -iTCP -sTCP:LISTEN -Fpn`, ports attributed to the task owning the pid; any lsof failure → no ports. Stop: rescan, find the task, `/bin/kill -TERM <subtree…>`, then spawn a thread that sleeps 2 s and sends `-KILL` to pids that still answer `kill -0`. Non-macOS: `scan` returns `Ok(vec![])`.
- [ ] **Step 4: Run** → PASS; `cargo test` all → PASS.
- [ ] **Step 5: Commit** `feat: scan and stop shell processes agents started`.

### Task 7: Background task model and polling hook

**Files:**
- Create: `src/lib/background-tasks.ts`, `src/hooks/useBackgroundProcesses.ts`, `src/hooks/useBackgroundTasks.ts`
- Modify: `src/hooks/useAcpSessions.ts` (`busySince: Record<string, number>` — set to `Date.now()` when a prompt starts busy, deleted on `turn-end`/`exit`; exposed as `busySinceOf(sessionId): number | undefined`)
- Test: `src/test/background-tasks.test.ts`, `src/test/use-background-processes.test.tsx`, `src/test/use-acp-sessions.test.tsx`

**Interfaces:**
- Produces:
  - `export type BackgroundTaskKind = 'agent' | 'terminal' | 'process'`
  - `export interface BackgroundProcess { pid: number; sessionId: string; command: string; elapsedSecs: number; ports: number[] }`
  - `export interface BackgroundTask { id: string; kind: BackgroundTaskKind; name: string; detail?: string; status: 'Working' | 'Needs approval' | 'Running'; startedAt: number; sessionId: string; pid?: number }` (ids: `agent:<sid>`, `terminal:<sid>`, `process:<pid>`)
  - `export function backgroundTasksOf(input: { sessions: readonly Session[]; isAcp: (s: Session) => boolean; isBusy: (id: string) => boolean; busySince: (id: string) => number | undefined; needsApproval: (id: string) => boolean; processes: readonly BackgroundProcess[]; now: number }): BackgroundTask[]`
  - `export function formatElapsed(ms: number): string`
  - `useBackgroundProcesses(hasLiveSessions: boolean, isMenuOpen: boolean): { processes: BackgroundProcess[]; reload: () => void }` — intervals `BACKGROUND_POLL_MS = 5000`, `BACKGROUND_POLL_OPEN_MS = 2000`.
  - `useBackgroundTasks(args): { tasks: BackgroundTask[]; isMenuOpen: boolean; setMenuOpen: (open: boolean) => void; open: (task: BackgroundTask) => void; stop: (task: BackgroundTask) => Promise<void> }` — `stop` invokes `acp_cancel {sessionId}`, `terminate_session {sessionId}` or `stop_background_process {pid}` by kind, then `reload()`; a rejection goes to `onError` as `Could not stop <name>: <error>`.

- [ ] **Step 1: Write failing tests.**
  - `formatElapsed(45_000) === "45s"`, `133_000` → `"2m 13s"`, `3_840_000` → `"1h 04m"`.
  - `backgroundTasksOf`: a busy ACP session started at 1000 with `needsApproval` true → `{kind:'agent', status:'Needs approval', startedAt:1000}`; an idle ACP session → none; a running non-ACP session (`createdAt: 500`) → `{kind:'terminal', status:'Running', startedAt:500}`; a terminated one → none; a process `{pid:11, sessionId:'s1', elapsedSecs:30, ports:[5173]}` with `now = 100_000` → `{kind:'process', name:'npm run dev', detail:'<s1 name> · localhost:5173', startedAt:70_000}`; result sorted oldest first.
  - Polling (fake timers): with `hasLiveSessions` false no invoke; true → one immediate `background_processes` call, another at +5000 ms; with `isMenuOpen` true the next comes at +2000 ms; unmount stops polling.
  - `useAcpSessions`: `busySinceOf(id)` is a number after a prompt and `undefined` after a `turn-end` event.
- [ ] **Step 2: Run** `npx vitest run src/test/background-tasks.test.ts src/test/use-background-processes.test.tsx src/test/use-acp-sessions.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Session names come from `sessions`; a process whose session is unknown uses detail without the name.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: background task model and process polling`.

### Task 8: Background tasks menu in the TopBar

**Files:**
- Create: `src/components/topbar/BackgroundTasksMenu.tsx`
- Modify: `src/components/TopBar.tsx` (optional `backgroundTasks?: BackgroundTasksMenuProps` rendered first in the right group), `src/App.tsx` (call `useBackgroundTasks` with `sessions`, `isAcp`, `acp.isBusy`, `acp.busySinceOf`, `needsApproval = (id) => isAwaitingPermission(transcripts[id] ?? [])`, `open = handleSelectSession`, `onError = reportError`)
- Test: `src/test/background-tasks-menu.test.tsx`, `src/test/top-bar.test.tsx`

**Interfaces:**
- Consumes: Task 7.
- Produces: `BackgroundTasksMenuProps { tasks: BackgroundTask[]; isOpen: boolean; onOpenChange: (open: boolean) => void; onOpenTask: (task: BackgroundTask) => void; onStopTask: (task: BackgroundTask) => Promise<void> }`.

- [ ] **Step 1: Write failing tests.** Trigger is an `IconButton` named `"Background tasks"`; with 2 tasks it shows badge `2` and is named `"Background tasks (2 running)"`; click → `onOpenChange(true)`; open with tasks renders a `list` named `"Running tasks"` whose rows show name, status, detail and `formatElapsed` duration; with fake timers advancing 1000 ms the duration text changes (`"45s"` → `"46s"`); "Open npm run dev" calls `onOpenTask(task)` and `onOpenChange(false)`; "Stop npm run dev" calls `onStopTask` and the button reads "Stopping…" and is disabled until the task leaves `tasks`; open with no tasks → "Nothing running."; Escape → `onOpenChange(false)`. TopBar renders the menu only when `backgroundTasks` is given.
- [ ] **Step 2: Run** `npx vitest run src/test/background-tasks-menu.test.tsx src/test/top-bar.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Popover `absolute right-0 top-full mt-1 w-96 rounded-lg border border-border bg-surface-2 shadow-…` (use the existing popover shadow token used by `OptionDropdown`); kind icons `Bot`, `Terminal`, `Cog` from lucide-react; the 1 s tick runs only while `isOpen`.
- [ ] **Step 4: Run** → PASS; `wc -l src/App.tsx` < 800.
- [ ] **Step 5: Commit** `feat: background tasks menu in the top bar`.

### Task 9: Full verification and PR

- [ ] **Step 1:** `npx vitest run` → all pass; `npx tsc --noEmit` → no output; `cd src-tauri && cargo test` → all pass; `pnpm lint` (if defined) clean.
- [ ] **Step 2:** Run the app (`run` skill / `pnpm tauri dev`) and check in light and dark mode: chip numbers match `git diff --numstat`, diff view targets switch, a `pnpm dev` started by an agent shows in Background tasks with its port and stops.
- [ ] **Step 3:** Push `feat/diff-view-background-tasks` with `-u` and open a PR to `main` summarizing both features, the test plan, and what was verified by hand.
