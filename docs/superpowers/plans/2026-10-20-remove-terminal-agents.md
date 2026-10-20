# Remove terminal agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Oh-My-Pi, Aider and the PTY session engine, keeping the PTY plumbing terminal sign-in uses, and clean old saved state.

**Architecture:** Every agent becomes an ACP chat agent. The backend keeps `PtySessionManager` plus `send_input`/`resize_session`/`terminate_session` for sign-in terminals (`signin-` ids, `sign-in-terminal` event) and drops `spawn_session`, `spawn_plan.rs` and the `pty-output`/`pty-exit` events. The frontend drops the PTY engine, its parser and its UI. On load, sessions that are not ACP are deleted with their transcripts, and settings naming `omp`/`aider` are cleaned.

**Tech Stack:** Tauri 2 (Rust), React 19, TypeScript, Vitest + Testing Library, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-20-remove-terminal-agents-design.md`

## Global Constraints

- Work in `/Users/mac/developer/agent-desktop/.claude/worktrees/remove-terminal-agents` on branch `refactor/remove-terminal-agents`. Never switch branches, stash or reset there.
- Stage explicit paths only (`git add <paths>`, `git rm <paths>`); never `git add -A` or `git add .`.
- Conventional Commits (`refactor:`, `test:`, `docs:`, `chore:`), in English.
- Removed agent ids: exactly `omp` and `aider`.
- A terminal session is any session whose `transport` is not `"acp"` (`"pty"` or missing).
- `STATE_VERSION` becomes `2`.
- Keep unchanged: `src-tauri/src/pty_session.rs` behavior, `send_input` (sync), `resize_session`, `terminate_session`, `end_orphaned_sessions`, `acp_start_terminal_sign_in`, `acp_cancel_terminal_sign_in`, the `sign-in-terminal` event, `TerminalView`, `PtyOutputStore`, `lib/xterm-options.ts`, `TerminalSignInDialog`, `useTerminalSignIn`, `src/test/xterm-release-build.test.ts`, and `esbuild.minifySyntax: false` in `vite.config.ts`.
- Design-system rules from `CLAUDE.md` hold for any UI line touched (tokens only, no raw colors).
- UI copy: sentence case, short declarative sentences, "you", name the agents.
- Each task ends green on its own checks: frontend tasks `pnpm lint` and `pnpm test`; backend task `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` (from `src-tauri/`; `dist/` already exists).
- Sub-project 4 edits `App.tsx`, Onboarding, the Settings agent list, `profiles.rs` and `src/test/fixtures/agents.ts` at the same time: change those only as far as the removal needs.

## Review Focus

- A saved file whose sessions are all terminal sessions loads to an empty list, without a crash and without a stuck "loading" state. Test in Task 1.
- A transcript that cannot be deleted (backend rejects) still lets the app load and reports one notice. Test in Task 1.
- A version 1 file written again later (an older Zorvo) is cleaned again on the next load. Test in Task 1 (`dropTerminalSessions` does not look at `version`).
- A sign-in terminal still receives keystrokes, resizes and is terminated after the PTY engine is gone. Covered by the kept `terminal-sign-in.test.tsx`; Task 3 adds an assertion that `send_input` is invoked with the `signin-` id.
- A running sign-in PTY does not show in the Background tasks menu. Covered in Task 2 by construction: `session_roots` takes only `&AcpManager`, so a PTY cannot be a root (the reviewer checks the signature).

---

### Task 1: Clean saved state of terminal sessions and removed agents

**Files:**
- Modify: `src/lib/persistence.ts`
- Modify: `src/hooks/usePersistedState.ts`
- Test: `src/test/persistence.test.ts`, `src/test/use-persisted-state.test.tsx` (create if no hook test exists; check `ls src/test | grep -i persist` first and extend the existing one)

**Interfaces:**
- Produces:
  - `export const STATE_VERSION = 2;`
  - `export const REMOVED_AGENT_IDS: readonly string[] = ['omp', 'aider'];`
  - `export function dropTerminalSessions(state: PersistedState): { state: PersistedState; droppedSessionIds: string[] }` (pure; returns the same `state` object when nothing is dropped)
  - `normalizePersistedState` writes `version: STATE_VERSION` and cleans removed agents out of `defaultAgentId`, `enabledAgents`, `removedAgents`, `agentVersions`, `agentOptions`.

- [ ] **Step 1: Write the failing tests in `src/test/persistence.test.ts`**

```ts
it('drops pty and transport-less sessions and keeps acp ones', () => {
  const state = normalizePersistedState({ sessions: [
    session({ id: 'a', transport: 'acp' }),
    session({ id: 'p', transport: 'pty' }),
    session({ id: 'old' }), // saved before ACP: no transport
  ] });
  const { state: cleaned, droppedSessionIds } = dropTerminalSessions(state);
  expect(cleaned.sessions.map((s) => s.id)).toEqual(['a']);
  expect(droppedSessionIds).toEqual(['p', 'old']);
});

it('returns the same state when there is no terminal session', () => {
  const state = normalizePersistedState({ sessions: [session({ id: 'a', transport: 'acp' })] });
  expect(dropTerminalSessions(state)).toEqual({ state, droppedSessionIds: [] });
  expect(dropTerminalSessions(state).state).toBe(state);
});

it('cleans omp and aider out of the settings and agent options', () => {
  const state = normalizePersistedState({
    version: 1,
    settings: {
      defaultAgentId: 'omp',
      enabledAgents: ['omp', 'claude-acp', 'aider'],
      removedAgents: ['aider', 'gemini'],
      agentVersions: { omp: '1.0.0', 'claude-acp': '0.5.0' },
    },
    agentOptions: { omp: { preferredConfig: { model: 'opus' } }, 'claude-acp': {} },
  });
  expect(state.version).toBe(2);
  expect(state.settings.defaultAgentId).toBeNull();
  expect(state.settings.enabledAgents).toEqual(['claude-acp']);
  expect(state.settings.removedAgents).toEqual(['gemini']);
  expect(state.settings.agentVersions).toEqual({ 'claude-acp': '0.5.0' });
  expect(Object.keys(state.agentOptions ?? {})).toEqual(['claude-acp']);
});
```

`session(...)` is whatever session-builder the file already has; add a minimal one (`{ id, name: id, profileId: 'claude-acp', cwd: '/w', status: 'terminated', createdAt: 1, ...overrides }`) if none exists. Keep any existing test that asserts `version` passes through, updated to expect `2`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/test/persistence.test.ts`
Expected: FAIL (`dropTerminalSessions` is not exported; version is 1; omp still present).

- [ ] **Step 3: Implement in `src/lib/persistence.ts`**

Add `REMOVED_AGENT_IDS` and an `isRemovedAgent(id)` helper; filter it out of the id lists and record keys after canonicalising; map a removed `defaultAgentId` to `null`; set `version: STATE_VERSION`. `dropTerminalSessions` keeps `transport === TRANSPORT_ACP` (import from `../types`). Update the `isSession` doc or add one line on why terminal sessions are dropped.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run src/test/persistence.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing hook tests**

Using the fake store (`window.__FAKE_TAURI_STORE__`, see `src/test/setup.ts`) or a mocked `invoke`, render `usePersistedState` with saved sessions `[acp 'a', pty 'p', transport-less 'old']`:

```ts
it('deletes the transcripts of dropped terminal sessions and saves the cleaned state', async () => {
  // arrange saved state with sessions a (acp), p (pty), old (no transport)
  const { result } = renderHook(() => usePersistedState(onError));
  await waitFor(() => expect(result.current.isLoaded).toBe(true));
  expect(result.current.state.sessions.map((s) => s.id)).toEqual(['a']);
  expect(invoke).toHaveBeenCalledWith('delete_transcript', { sessionId: 'p' });
  expect(invoke).toHaveBeenCalledWith('delete_transcript', { sessionId: 'old' });
  await waitFor(() => expect(savedState().sessions.map((s) => s.id)).toEqual(['a']));
  expect(onError).not.toHaveBeenCalled();
});

it('still loads when a transcript cannot be deleted', async () => {
  // delete_transcript rejects with 'disk full'
  // isLoaded becomes true, sessions are ['a'], onError called once with a message containing 'disk full'
});

it('loads a file whose sessions are all terminal sessions as an empty list', async () => {
  // sessions [pty 'p'] -> isLoaded true, sessions []
});
```

`savedState()` reads what `save_app_state` received (fake store or the mock's last call). Use fake timers or `waitFor` past `SAVE_DEBOUNCE_MS`.

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm vitest run src/test/use-persisted-state.test.tsx`
Expected: FAIL (sessions still contain `p` and `old`; no `delete_transcript` call).

- [ ] **Step 7: Implement in `src/hooks/usePersistedState.ts`**

In the load `.then`: run `dropTerminalSessions(loaded)`; set `lastSavedRef.current = loaded` (so the cleaned state differs and the save effect writes it); `setState(cleaned)`; for each dropped id call `deleteTranscript(id)` and report a rejection through `onErrorRef.current` with copy `Could not delete a removed terminal session: ${String(error)}` (one notice per failure is acceptable; do not block `setIsLoaded(true)` on the deletes).

- [ ] **Step 8: Run the frontend checks**

Run: `pnpm vitest run src/test/persistence.test.ts src/test/use-persisted-state.test.tsx && pnpm lint && pnpm test`
Expected: all PASS. Fix any existing test that seeded a `pty`/transport-less session and expected it to load (switch it to `transport: 'acp'` or delete the case if it was about terminal sessions).

- [ ] **Step 9: Commit**

```bash
git add src/lib/persistence.ts src/hooks/usePersistedState.ts src/test/persistence.test.ts src/test/use-persisted-state.test.tsx <other test files changed>
git commit -m "refactor: drop saved terminal sessions and removed agents on load"
```

---

### Task 2: Remove terminal agents and spawn_session from the backend

**Files:**
- Modify: `src-tauri/src/profiles.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/acp/commands.rs`, `src-tauri/src/registry/resolve.rs`, `src-tauri/src/background_processes.rs`, `src-tauri/src/pty_session.rs` (only `root_pids`, if unused afterwards)
- Delete: `src-tauri/src/spawn_plan.rs`, `src-tauri/tests/spawn_plan_test.rs`
- Test: `src-tauri/tests/profiles_test.rs`, `src-tauri/tests/registry_resolve_test.rs`, `src-tauri/tests/store_test.rs` (only if it fails), unit tests in `acp/commands.rs`, `background_processes.rs`

**Interfaces:**
- Produces (Rust): `AgentProfile` without `models`, `model_arg`, `effort_levels`, `permission_modes`, `session_id_arg`, `fork_support`, `resume_fork_args`, `approval_pattern`, `approval_key`, `reject_key`, `transport`. No `EffortLevel`, `PermissionModeOption`, `FORK_SUPPORT_*`, `TRANSPORT_*`, `get_default_profiles`, `spawn_session`, `spawn_plan` module. `get_available_agent_profiles()` returns registry agents only.
- Produces (wire): profiles serialized to the UI no longer carry those keys; the `pty-output`, `pty-output-<id>`, `pty-exit`, `pty-exit-<id>` events are never emitted. Task 4 removes the matching TS fields.
- `session_roots(acp: &AcpManager) -> Vec<(String, u32)>` in `background_processes.rs`; the commands `background_processes` and `stop_background_process` no longer take `State<PtySessionManager>`.

- [ ] **Step 1: Delete the spawn plan and the static agents**

`git rm src-tauri/src/spawn_plan.rs src-tauri/tests/spawn_plan_test.rs`. In `profiles.rs` delete `omp_profile`, `aider_profile`, `get_default_profiles`, the listed fields, their builders, `EffortLevel`, `PermissionModeOption`, the fork and transport constants, and rewrite the struct doc so it no longer names `omp`. `get_available_agent_profiles` keeps only the registry half. `AgentProfile::new` keeps the remaining fields' defaults.

- [ ] **Step 2: Remove spawn_session and the PTY session events in `lib.rs`**

Drop `pub mod spawn_plan`, the `spawn_session` command and its `generate_handler!` entry, the `TRANSPORT_PTY`/`build_spawn_plan` imports, and the `pty-output`/`pty-exit` emits. The `PtySessionManager` callback emits `SIGN_IN_TERMINAL_EVENT` for `is_sign_in_terminal_id` ids and ignores every other id, with a one-line comment that only sign-in terminals start a PTY. Rewrite the `send_input` comment so it speaks of a sign-in terminal's keystrokes instead of agent sessions. Keep `send_input`, `resize_session`, `terminate_session`, `end_orphaned_sessions`.

- [ ] **Step 3: Drop the transport checks**

`acp/commands.rs`: remove the `profile.transport != TRANSPORT_ACP` refusal in `launch_for` and the unit test around line 537 that expects a terminal agent to be refused; remove `profile.transport = …` at line ~647 in a test helper. `registry/resolve.rs:352`: remove the assignment.

- [ ] **Step 4: Build session roots from ACP only**

In `background_processes.rs`, `session_roots` takes only `&AcpManager`; both commands drop the `pty` state parameter. Add a unit test only if `session_roots` is testable without a live manager; otherwise note in the commit body that sign-in PTYs are no longer roots. Delete `PtySessionManager::root_pids` if nothing calls it (`grep -rn root_pids src-tauri`), with its test if any.

- [ ] **Step 5: Fix the Rust tests**

`profiles_test.rs`: delete the `omp`/`aider` tests, the PTY transport assertions (lines ~39-42, ~364) and the field-honesty tests for removed fields (effort levels, permission modes, fork support). Keep tests about registry profiles, adjusted to the smaller struct. `registry_resolve_test.rs:198`: drop the transport assertion. Run `grep -rnE "transport|omp|aider|spawn_plan|SpawnOptions|effort_levels|permission_modes|fork_support" src-tauri/src src-tauri/tests` and resolve every hit that refers to removed code (`store.rs`'s session `transport` stays; `manager.rs`/`connection.rs` "transport failure" wording is unrelated).

- [ ] **Step 6: Run the backend checks**

Run (in `src-tauri/`): `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: all PASS, including `acp_manager_test` and the terminal-auth tests.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/profiles.rs src-tauri/src/lib.rs src-tauri/src/acp/commands.rs src-tauri/src/registry/resolve.rs src-tauri/src/background_processes.rs src-tauri/src/pty_session.rs src-tauri/tests/profiles_test.rs src-tauri/tests/registry_resolve_test.rs
git commit -m "refactor: remove Oh-My-Pi, Aider and spawn_session from the backend"
```

(`git rm` in Step 1 already staged the deletions.)

---

### Task 3: Remove the PTY session engine from the frontend

**Files:**
- Delete: `src/hooks/session-engine/usePtyEngine.ts`, `src/hooks/usePtyEvents.ts`, `src/lib/stream-parser.ts`, `src/lib/apply-parsed-events.ts`, `src/components/TerminalDrawer.tsx`, `src/test/use-pty-engine.test.tsx`, `src/test/stream-parser.test.ts`, `src/test/apply-parsed-events.test.ts`, `src/test/terminal-drawer.test.tsx`
- Modify: `src/App.tsx`, `src/hooks/session-engine/useAcpEngine.ts`, `src/hooks/useSessionActions.ts`, `src/hooks/useSessionFork.ts`, `src/lib/session-start.ts`, `src/lib/acp-events.ts`, `src/lib/session-helpers.ts` (only if it held PTY helpers), `src/components/ActionCard.tsx`, `src/components/ChatCanvas.tsx`, `src/components/PopoutApp.tsx`, `src/lib/popout-bridge.ts`, `src/lib/background-tasks.ts`, `src/hooks/useBackgroundTasks.ts`, the TopBar background-tasks menu component, `src/types/index.ts` (only the types named below), `src/test/setup.ts`
- Test: every suite in `src/test/` that drives a terminal session (see Step 6)

**Interfaces:**
- Consumes: Task 2's wire change (no `spawn_session`, no `pty-output`).
- Produces:
  - `EngineDeps` exported from `src/hooks/session-engine/useAcpEngine.ts` (same shape as before, moved).
  - `PopoutAction = { kind: 'send'; text: string } | { kind: 'choose-option'; cardId: string; optionId: string } | { kind: 'stop' }`.
  - `BackgroundTaskKind = 'agent' | 'process'`; `BackgroundTasksInput` and `BackgroundTasksArgs` without `isAcp`.
  - `ChatCanvas` props without `onSendPtyInput`, `onApproveAction`, `onRejectAction`.
  - `ActionCard` type without `approvalKey`/`rejectKey`; `ParsedStreamEvent`, `ParsedStreamEventType`, `PtyOutputPayload`, `PtyExitPayload` removed from `types/index.ts`.
  - `isWaitingForAnswer(session, messages, isBusy)` keeps its signature and answers `isBusy() && isAwaitingPermission(messages)` for any running session; `isAwaitingPermission` loses its `includeTerminal` option.
  - `SessionSpec` keeps `options?: SpawnOptions` for now (Task 4 removes it).

- [ ] **Step 1: Delete the engine files and their tests**

`git rm` the files listed under Delete. Move `EngineDeps` into `useAcpEngine.ts`.

- [ ] **Step 2: Make `App.tsx` single-engine**

Remove `usePtyEngine`, `ptyOutput`/`createPtyOutputStore`, the `TerminalView` main view and `showsTerminal`/`isActiveTerminal`, the drop path that typed paths into a terminal (dropped files always go to the composer), `pty.start`/`pty.send`/`pty.interrupt`/`pty.resolveCard`/`pty.sendRaw`/`pty.resize` calls, the `isAcp` engine switches (`isSessionBusy` becomes `acp.isBusy(id) || isRestarting(id)`), the popout `resolve-card` branch, and the ChatCanvas y/n props. `startSession` always calls `acp.start`. `attachAsFiles` becomes `true`. Keep `isResumable` logic as is. Do not touch onboarding, Settings or agent-picker code beyond compile fixes.

- [ ] **Step 3: Remove the y/n card path and the terminal background task**

`ActionCard.tsx`/`ChatCanvas.tsx`/`PopoutApp.tsx`/`popout-bridge.ts` per Interfaces; ACP permission cards (options, `onChooseOption`) keep working. `acp-events.ts`: stop writing `approvalKey`/`rejectKey`, drop `includeTerminal`. `background-tasks.ts`/`useBackgroundTasks.ts`/TopBar menu: drop the `terminal` kind, its `stopCall` branch and its icon/label.

- [ ] **Step 4: Single-engine session actions and fork**

`useSessionActions.ts`: drop the `pty` dependency; stop/delete use `acp` only. `useSessionFork.ts`: drop the native PTY fork branch (`fork_support === 'native'`); keep the ACP native fork and the handoff fork. `session-start.ts`: `isWaitingForAnswer` per Interfaces; `newSessionRecord` sets `transport: TRANSPORT_ACP`.

- [ ] **Step 5: Remove the PTY fakes**

`src/test/setup.ts`: drop the `spawn_session` case; keep `send_input`, `resize_session`, `terminate_session` (sign-in uses them). Remove the `pty-output` listen helpers if any.

- [ ] **Step 6: Fix the suites that drove terminal sessions**

Run `grep -rlnE "ompProfile|aiderProfile|spawn_session|pty-output|transport: ['\"]pty|TerminalDrawer|resolve-card|onSendPtyInput|kind: ['\"]terminal" src/test`. For each hit: delete the case when it tests terminal-session behavior; switch it to an ACP agent (`claudeProfile`/`qwenProfile`) when it tests something general that only happened to use a terminal agent. Leave `ompProfile`/`aiderProfile` exports in `fixtures/agents.ts` for Task 4.

- [ ] **Step 7: Pin sign-in input routing**

In `src/test/terminal-sign-in.test.tsx`, make sure one test types into the sign-in terminal and asserts `invoke('send_input', { sessionId: <the signin- id>, data })`, and one asserts `resize_session` with that id. Add them if missing.

- [ ] **Step 8: Run the frontend checks**

Run: `pnpm lint && pnpm test`
Expected: all PASS. `grep -rnE "usePtyEngine|usePtyEvents|stream-parser|apply-parsed-events|TerminalDrawer|spawn_session|pty-output|pty-exit" src` returns nothing.

- [ ] **Step 9: Commit**

```bash
git add <every modified source and test file>   # git rm already staged the deletions
git commit -m "refactor: remove the terminal session engine from the frontend"
```

---

### Task 4: Remove terminal-agent profile fields and fixtures from the frontend

**Files:**
- Modify: `src/types/index.ts`, `src/lib/composer-controls.ts`, `src/lib/composer-state.ts`, `src/lib/session-start.ts`, `src/hooks/useSessionFork.ts`, `src/App.tsx` (draft state only), `src/hooks/useAgentProbe.ts`, `src/lib/enabled-agents.ts`, `src/lib/agent-readiness.ts`, `src/test/fixtures/agents.ts`, affected tests

**Interfaces:**
- Consumes: Task 2's profile wire shape; Task 3's single engine.
- Produces:
  - `AgentProfile` (TS) without `models`, `model_arg`, `effort_levels`, `permission_modes`, `session_id_arg`, `fork_support`, `resume_fork_args`, `approval_pattern`, `approval_key`, `reject_key`, `transport`. `EffortLevel`, `PermissionModeOption`, `ForkSupport`, `SpawnOptions` removed. `AgentTransport = 'acp'`, `TRANSPORT_ACP` kept for sessions; `Session.transport?: string` (old files hold `"pty"`).
  - `composer-controls.ts` without `ptyDraftControls`, `ptySessionControls`, `SessionDraft`; `session-start.ts` without `EMPTY_DRAFT`, `spawnOptionsFor`, and `SessionSpec.options`.
  - `composerStateFor` no longer takes `draft`/`setDraft`; a non-ACP session or draft gets `{ controls: {}, locked: false }`.
  - `isInUse(agent, settings)` without the `builtin` branch.

- [ ] **Step 1: Trim the types and fix every compile error**

Edit `types/index.ts` per Interfaces, then run `pnpm exec tsc --noEmit` and fix each error: drop the PTY controls and draft state (`App.tsx` `draft`/`setDraft`/`EMPTY_DRAFT` and the effect resetting it), `spawnOptionsFor` and its call in `useSessionFork.ts`, `agent.transport` checks (`useAgentProbe.ts` uses `agent?.id`; `composer-state.ts` treats every agent as ACP), the `builtin` branch in `enabled-agents.ts`, and the `omp`/`aider` entries in `INSTALL_HINTS` (`agent-readiness.ts`; drop the map if it becomes empty, keeping the docs fallback).

- [ ] **Step 2: Fixtures commit**

In `src/test/fixtures/agents.ts`: remove `ompProfile`, `aiderProfile`, the removed fields from `makeProfile`, and drop them from `fakeProfiles`. Fix tests that imported them (switch to an ACP fixture or delete terminal-only cases), and remove assertions on deleted fields (`composer-state.test.ts`, `enabled-agents.test.ts`, `agent-readiness.test.ts`, `onboarding*.test.tsx`, `settings-panel.test.tsx`, `new-session.test.tsx`, `agents-in-use.test.tsx`, others the compiler names).

- [ ] **Step 3: Run the frontend checks**

Run: `pnpm lint && pnpm test`
Expected: all PASS. `grep -rnE "omp|aider|Oh-My-Pi|Aider|effort_levels|permission_modes|fork_support|session_id_arg|model_arg|approval_key|reject_key|TRANSPORT_PTY|'pty'" src --include=*.ts --include=*.tsx` returns only `Session.transport` handling in `persistence.ts`/tests and unrelated words.

- [ ] **Step 4: Commit (two commits)**

```bash
git add src/types/index.ts src/lib/composer-controls.ts src/lib/composer-state.ts src/lib/session-start.ts src/hooks/useSessionFork.ts src/App.tsx src/hooks/useAgentProbe.ts src/lib/enabled-agents.ts src/lib/agent-readiness.ts <non-fixture tests>
git commit -m "refactor: drop terminal-agent fields from agent profiles"
git add src/test/fixtures/agents.ts <tests changed only for the fixture>
git commit -m "test: drop the Oh-My-Pi and Aider fixtures"
```

If the two commits cannot each pass on their own, make one commit and say so in the report.

---

### Task 5: Docs, site, comments and changelog

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `src/assets/agents/README.md`, `site/components/sections/Hero.tsx`, `site/components/sections/Features.tsx`, `site/components/sections/Agents.tsx`, `site/components/sections/SiteFooter.tsx`, `src/test/site.test.tsx`, comments in `src/components/ComposerDock.tsx`, `src/components/chat/ToolCallList.tsx`, `src/hooks/useUnreadMarks.ts`, `src/hooks/useTurnsEnded.ts`, `src/lib/acp-events.ts`, `src/components/TerminalView.tsx`

- [ ] **Step 1: CLAUDE.md**

"What this is": Qwen Code, Claude Code, Codex and every other agent come from the ACP registry and are driven over ACP as a chat UI; Pi comes through the registry's `pi-acp` adapter; a PTY is used only to run an agent's own terminal sign-in. Replace "Two session engines" with one paragraph on `useAcpEngine.ts` (drop `usePtyEngine`/`stream-parser`). Agent profiles paragraph: drop "Terminal agents (Oh-My-Pi, Aider) are still declared statically in `profiles.rs`" and `spawn_plan.rs`; the webview sends an agent id and `acp/commands.rs::launch_for` validates it. Frontend ↔ backend: drop `pty-output-<id>`/`pty-exit-<id>`; mention `sign-in-terminal`. Threading rule: `send_input` stays sync so a sign-in terminal's keystrokes reach the PTY in order. Testing commands: drop the `stream-parser` example (use `src/test/persistence.test.ts`).

- [ ] **Step 2: README, assets README, site**

README: remove Aider and Oh-My-Pi from the agent list and any "real TUI"/PTY session text. `src/assets/agents/README.md`: drop the Oh-My-Pi/Aider line. Site: Hero lists "Claude Code, Codex, Qwen and every agent in the ACP registry" (or similar short copy without Aider); Features drops the TUI feature card or replaces it with "Sign in from inside Zorvo: an agent's own login runs in a terminal in the app."; Agents section drops the terminal-tab mock and its paragraph (keep the section's ACP content; delete `TerminalTab` if unused); SiteFooter drops Aider and Oh-My-Pi. Update `src/test/site.test.tsx` expectations.

- [ ] **Step 3: Comments in kept code**

Rewrite or drop comments that explain terminal agents in the files listed above (for `TerminalView.tsx`, it now shows a sign-in terminal). No behavior change.

- [ ] **Step 4: CHANGELOG**

Under `Unreleased`, add: `- Removed Oh-My-Pi, Aider and terminal sessions. Every agent now runs as an ACP chat. Saved terminal sessions are deleted the first time Zorvo opens.` (match the section's existing heading style, e.g. a `Removed` subsection if the file uses Keep a Changelog).

- [ ] **Step 5: Run the checks**

Run: `pnpm lint && pnpm test`
Expected: all PASS (site and design-system docs tests included).

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md CHANGELOG.md src/assets/agents/README.md site/components/sections/Hero.tsx site/components/sections/Features.tsx site/components/sections/Agents.tsx site/components/sections/SiteFooter.tsx src/test/site.test.tsx <comment-only files>
git commit -m "docs: describe Zorvo as ACP-only and drop terminal agents"
```
