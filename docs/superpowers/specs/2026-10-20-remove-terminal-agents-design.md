# Remove terminal agents — design

Date: 2026-10-20
Branch: `refactor/remove-terminal-agents`
Sub-project 5 of 5 in "every ACP agent, set up inside Zorvo"

## Goal

Every agent in Zorvo is an ACP chat agent. Oh-My-Pi and Aider leave, and so
does the engine that ran an agent as a TUI in a PTY. Pi stays available
through the registry's `pi-acp` adapter, which needs nothing from this
sub-project. The PTY stays only for terminal sign-in (sub-project 3).

Done means the two agents and the terminal-session engine are gone, terminal
sign-in still works, old saved state loads, and `pnpm lint`, `pnpm test`,
`cargo clippy --all-targets -- -D warnings` and `cargo test` pass.

## Decisions

| Topic | Decision |
|---|---|
| Saved terminal sessions | Deleted when the state loads, together with their transcripts. |
| Which sessions count as terminal sessions | Every session whose `transport` is not `"acp"`: `"pty"`, and also a missing `transport`. Sessions saved before ACP existed (before 2026-10-17) have none, and all of them ran in a terminal, whichever agent they used. |
| Worktrees of deleted sessions | Left on disk. They can hold uncommitted work. `git worktree list` still shows them. |
| Settings naming `omp` or `aider` | Removed from `enabledAgents`, `removedAgents`, `agentVersions` and `agentOptions` (which holds the last-used model and options). A `defaultAgentId` of either becomes `null`, so the first ready agent is the default again. |
| `STATE_VERSION` | Goes from 1 to 2, so a saved file says it has been migrated. The clean-up itself runs on every load. It does nothing on a clean file, so an older Zorvo writing a version 1 file later is still handled. |
| Approach | Full removal: profile fields and helpers that only the terminal agents used go too, instead of staying behind with a fixed `"acp"` value. |

## What each side uses

Traced on `main` at 09f227e.

| Piece | Terminal sessions | Terminal sign-in | Outcome |
|---|---|---|---|
| `pty_session.rs` (`PtySessionManager`) | yes | yes | Kept |
| `send_input`, `resize_session`, `terminate_session` | yes | yes (`useTerminalSignIn`) | Kept. `send_input` stays sync. |
| `end_orphaned_sessions` (`pty.kill_all()`) | yes | yes (a sign-in left by a reload) | Kept |
| `spawn_session` | yes | no | Removed |
| `spawn_plan.rs`, `tests/spawn_plan_test.rs` | yes (only `spawn_session` calls it) | no | Removed |
| `pty-output[-<id>]`, `pty-exit[-<id>]` events | yes | no (`signin-` ids go on `sign-in-terminal`) | Removed. `lib.rs` emits only `sign-in-terminal`. |
| `acp_start_terminal_sign_in`, `acp_cancel_terminal_sign_in`, `sign-in-terminal` | no | yes | Kept |
| `TerminalView`, `PtyOutputStore`, `lib/xterm-options.ts`, xterm | yes | yes (`TerminalSignInDialog`) | Kept |
| `usePtyEvents`, `TerminalDrawer` | yes | no | Removed |
| `background_processes.rs` session roots | PTY and ACP roots | a sign-in PTY is a root too | ACP roots only. A sign-in terminal belongs to its dialog and has no session to open from the menu. `PtySessionManager::root_pids` goes if nothing else calls it. |

## Backend

- `profiles.rs`: delete `omp_profile`, `aider_profile`, `get_default_profiles`
  and the static half of `get_available_agent_profiles`, which then lists the
  registry agents only. Delete `TRANSPORT_PTY` and `TRANSPORT_ACP`, and the
  fields only `spawn_plan` or the PTY engine read: `models`, `model_arg`,
  `effort_levels`, `permission_modes`, `session_id_arg`, `fork_support`,
  `resume_fork_args`, `approval_pattern`, `approval_key`, `reject_key` and
  `transport`. Their types, builders and constants (`EffortLevel`,
  `PermissionModeOption`, `FORK_SUPPORT_*`) go with them. `AgentProfile::new`
  becomes the registry agents' base. The doc comment that names `omp`
  changes too.
- `acp/commands.rs`: drop the transport check in `launch_for` and its
  test (every profile speaks ACP). `registry/resolve.rs` no longer sets
  `transport`.
- `lib.rs`: drop `spawn_session`, the `spawn_plan` module, the
  `pty-output`/`pty-exit` emits and the comment about them. The PTY event
  callback routes `signin-` ids to `sign-in-terminal` and ignores any other
  id (none can exist, since only `acp_start_terminal_sign_in` starts a PTY).
- `store.rs`: the session's `transport: Option<String>` stays, so the
  frontend can tell old sessions apart.
- Tests: delete `spawn_plan_test.rs` and the `omp`/`aider` and PTY cases in
  `profiles_test.rs`. Keep the rest, adjusted to the smaller profile.

## Frontend

- Delete `hooks/session-engine/usePtyEngine.ts` (its `EngineDeps` type moves
  to `useAcpEngine.ts`), `hooks/usePtyEvents.ts`, `lib/stream-parser.ts`,
  `lib/apply-parsed-events.ts`, `components/TerminalDrawer.tsx`, and their
  tests.
- `App.tsx`: one engine. Remove the `pty` engine, the `isAcp` branches
  that pick between engines, the terminal main view, the dropped-files path
  that typed paths into a terminal, and the props that wire y/n cards. Keep
  changes to the removal: sub-project 4 edits this file at the same time.
- `ActionCard`, `ChatCanvas`, `PopoutApp`, `popout-bridge`: remove the y/n
  card path (`approvalKey`/`rejectKey`, `onSendPtyInput`,
  `onApproveAction`/`onRejectAction`, the `resolve-card` popout action).
  ACP permission cards (`options` + `chooseOption`) stay.
- `useSessionActions`, `useSessionFork`, `session-start.ts`: remove the PTY
  stop/forget, the native PTY fork and `spawnOptionsFor`/`SpawnOptions`.
  Fork keeps the ACP native fork and the handoff fork.
- `composer-state.ts`, `composer-controls.ts`: remove the static model,
  effort and permission controls for terminal agents. ACP controls stay.
- `lib/background-tasks.ts`, `useBackgroundTasks.ts`, `TopBar`'s menu:
  drop the `terminal` kind. `agent` and `process` stay.
- `lib/enabled-agents.ts`: drop the `builtin` branch of `isInUse`. Nothing
  produces a `builtin` profile any more.
- `lib/agent-readiness.ts`: drop the `omp`/`aider` install hints.
- `types/index.ts`: remove the deleted profile fields, `AgentTransport`'s
  `'pty'`, `SpawnOptions`, `ParsedStreamEvent*`, `PtyOutputPayload`/
  `PtyExitPayload` and the y/n fields of `ActionCard`. `Session.transport`
  stays (typed as a string, since old files hold `"pty"`).
- Wording that explains terminal agents ("A terminal agent…") goes from
  comments in code that stays (`ComposerDock`, `ToolCallList`,
  `useUnreadMarks`, `useTurnsEnded`, `acp-events`).
- Kept unchanged: `TerminalView`, `PtyOutputStore`,
  `TerminalSignInDialog`, `useTerminalSignIn`, xterm,
  `xterm-release-build.test.ts` and `esbuild.minifySyntax: false` in
  `vite.config.ts`.

## Saved data

In `lib/persistence.ts`:

- `REMOVED_AGENT_IDS = ['omp', 'aider']`.
- `normalizePersistedState` drops the removed agents from the settings and
  `agentOptions` as described in *Decisions*, and writes `version: 2`.
- A new pure `dropTerminalSessions(state)` returns
  `{ state, droppedSessionIds }`: it keeps only sessions with
  `transport === 'acp'`.

In `hooks/usePersistedState.ts`, after `loadAppState`:

1. Run `dropTerminalSessions`.
2. When it dropped any, call `deleteTranscript` for each id. A failed
   delete is reported through `onError` and does not stop the load. A
   missing transcript already succeeds in the backend.
3. Set the cleaned state. `lastSavedRef` keeps the loaded state, so the
   save effect writes the cleaned one right after.

Only the main window loads and saves state (popouts render snapshots), so
the clean-up runs in one place. An active session id that pointed at a
dropped session shows the new-session view, as for any missing id.

## Docs

- `CLAUDE.md`: the "What this is" paragraph (all agents are ACP; the PTY is
  only for sign-in), the "Two session engines" paragraph (one engine), the
  `send_input` threading note (it now serves sign-in) and the agent-profile
  paragraph (no static terminal agents).
- `README.md`: the supported-agents list and any PTY mentions.
- `site/`: `Hero`, `Features`, `Agents` and `SiteFooter` mention Aider or
  Oh-My-Pi. The site test (`src/test/site.test.tsx`) follows.
- `src/assets/agents/README.md`: drop the Oh-My-Pi/Aider line.
- `CHANGELOG.md`, under Unreleased: Oh-My-Pi, Aider and terminal sessions
  are removed, and saved terminal sessions are deleted on the first start.
- Older specs and plans under `docs/superpowers/` stay as written: they
  record past decisions.

## Testing

- New: `normalizePersistedState` cleans the removed agents out of every
  setting and `agentOptions`; `dropTerminalSessions` drops `"pty"` and
  transport-less sessions and keeps `"acp"` ones; `usePersistedState`
  deletes their transcripts, saves the cleaned state, and still loads when a
  delete fails.
- Removed: tests of deleted modules (`stream-parser`, `use-pty-engine`,
  `apply-parsed-events`, `terminal-drawer`, `spawn_plan_test.rs`, the PTY
  parts of `profiles_test.rs`) and PTY cases inside other suites.
- Kept green: `terminal-sign-in.test.tsx`, `terminal-view.test.tsx`,
  `pty-output-store.test.ts`, `xterm-release-build.test.ts`, the Rust
  terminal-auth tests.
- `src/test/setup.ts` and `src/test/fixtures/agents.ts` lose the PTY
  agents and the `spawn_session` fake. Sub-project 4 edits the fixtures
  too, so the fixture change is its own commit.

## Overlap with sub-project 4

Sub-project 4 (catalog UI) edits `App.tsx`, Onboarding, the Settings agent
list, `profiles.rs` and `src/test/fixtures/agents.ts` at the same time. This
branch changes those files only for the removal, and merges `main` before
the PR is opened.
