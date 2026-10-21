# ACP session list and resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zorvo continues ended sessions with ACP `session/resume` when the agent offers it, and imports sessions started outside Zorvo from `session/list`, with their history shown.

**Architecture:** The Rust backend picks resume or load from `initialize` (`AcpManager::reopen` with a `ReopenPurpose`), routes an import's load replay through a notification-only `replaying` map, and reads every `session/list` page in one short-lived agent process (`acp/session_list.rs`). The React frontend renames `canLoad` to `canReopen`, folds a replay with `applyReplayUpdate`, and adds a "Continue a session from <Agent>" list to the new-session draft (`useAgentSessionList`, `AgentSessionList`, `useSessionImport`).

**Tech Stack:** Tauri 2, Rust (serde_json, std threads/mpsc), React 19, TypeScript, Tailwind 4, Vitest + Testing Library, Node fake ACP agent.

**Spec:** `docs/superpowers/specs/2026-10-21-acp-session-list-resume-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Work in the worktree `/Users/mac/developer/agent-desktop/.claude/worktrees/acp-session-list-resume`, branch `feat/acp-session-list-resume`. Never switch branches, stash or reset; stage explicit paths only (never `git add -A`).
- Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`), in English.
- The webview sends only agent ids, folders, app session ids and the `acpSessionId` it got from the list; never a command line. New Tauri commands go through `launch_in_workspace` (which calls `ensure_known_workspace`) and are `#[tauri::command(async)]`.
- No new network requests; no new crates or npm packages.
- `mcpServers: []` on resume as on new/load/fork; never send `additionalDirectories`.
- Agent data is untrusted: validate in Rust before the UI sees it; paths from the agent are only compared.
- Design system: tokens only (no raw colors), `ui/` `Button` before a hand-styled `<button>`, `focus-ring` on every focusable control, sentence-case copy that names the agent.
- Source files under 800 lines (`manager.rs` is 751, `App.tsx` is 774: put logic in new modules and hooks, wiring only in those two).
- Exact copy: "Continue a session from {agent}", "Asking {agent} for its sessions…", "{agent} has no other sessions in this folder.", "Showing the 200 most recent sessions.", "Some sessions could not be listed.", "Try again", "Earlier messages stay in {agent}. They are not shown here.", backend errors "This agent cannot resume earlier sessions" (existing) and "This agent cannot list its sessions".
- Limits: `MAX_LIST_PAGES = 10`, `MAX_LISTED_SESSIONS = 200`, list budget 120 s after `initialize`, `SESSION_REQUEST_TIMEOUT` per page, title cut to 200 characters, session id at most 256 characters.
- Gates before every commit of code: the task's own tests; before the PR: `pnpm lint`, `pnpm test`, `pnpm build`, then in `src-tauri/` `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (Node on PATH).

## Review Focus

1. **The draft's agent or folder changes while a list is loading.** The late answer must not show under the new agent or folder. Test in Task 8.
2. **The session disappears between the list and the import** (deleted in the agent's CLI). The import fails cleanly: record and transcript gone, back to the draft, and the agent's error shown in the list. Test in Task 9.
3. **A replayed tool call or permission request never got its final update.** After the import it must not look like it is still running or waiting. Test in Task 6.
4. **The user stops or deletes the imported session while its replay streams.** No later update lands in a transcript or a deleted session. Rust side in Task 2; UI side in Task 9.
5. **A listed title is empty, only whitespace, or multi-line markdown.** The session gets the fallback name or a one-line name, never a blank row. Tests in Task 3 (Rust cleaning) and Task 9 (`importedSessionSpec`).

---

### Task 1: Continue a session with resume when the agent offers it

**Files:**
- Create: `src-tauri/src/acp/manager/reopen.rs`
- Modify: `src-tauri/src/acp/manager.rs` (remove `load`, add `mod reopen;` + re-exports, `StartedSession.reopened_with`, set it to `None` in `started_session`)
- Modify: `src-tauri/src/acp/commands.rs` (`acp_load_session` → `acp_reopen_session`)
- Modify: `src-tauri/src/lib.rs` (`generate_handler!`)
- Modify: `src-tauri/tests/fixtures/fake_acp_agent.mjs`
- Modify: `src-tauri/tests/acp_manager_test.rs` (only the `manager.load(...)` calls)
- Create: `src-tauri/tests/common/mod.rs`, `src-tauri/tests/acp_session_reopen_test.rs`

**Interfaces:**
- Produces (Rust, re-exported from `acp::manager`):
  - `pub enum ReopenPurpose { Continue, Import }` (`Debug, Clone, Copy, PartialEq, Eq`)
  - `pub enum ReopenMethod { Resume, Load }` (`Debug, Clone, Copy, PartialEq, Eq, Serialize`, `#[serde(rename_all = "lowercase")]`)
  - `pub(super) fn reopen_method(agent_capabilities: &Value, purpose: ReopenPurpose) -> Option<ReopenMethod>`
  - `AcpManager::reopen(&self, app_session_id: &str, cwd: &str, launch: &AcpLaunch, acp_session_id: &str, purpose: ReopenPurpose) -> Result<StartedSession, String>`
  - `StartedSession.reopened_with: Option<ReopenMethod>`, serialized as `reopenedWith` and skipped when `None`
- Produces (Tauri): `acp_reopen_session(session_id, cwd, profile_id, acp_session_id) -> Result<StartedSession, String>` (purpose `Continue`)
- Produces (fake agent):
  - `FAKE_ACP_RESUME` adds `resume: {}` to `sessionCapabilities`; `session/resume` answers `{ modes }` (same modes as load) with no update.
  - `FAKE_ACP_CALL_LOG=<file>` appends every received method name plus `\n`.
  - The load replay sends `user_message_chunk` "earlier question" before its `agent_message_chunk` "replayed history".
- Produces (tests): `tests/common/mod.rs` with `fake_agent()`, `fake_agent_with(env: &[(&str, &str)])`, `cwd()`, `manager()`, `wait_for(..)`, `agent_text(..)`, `called_methods(path) -> Vec<String>`, copied from `acp_manager_test.rs` (that file keeps its own copies).

- [ ] **Step 1: Write the failing unit tests** in `reopen.rs` `#[cfg(test)]`:
  - `continue_prefers_resume`: caps `{loadSession: true, sessionCapabilities: {resume: {}}}` with `Continue` give `Some(Resume)`.
  - `continue_falls_back_to_load`: `{loadSession: true}` gives `Some(Load)`.
  - `import_prefers_load`: the same caps with `Import` give `Some(Load)`.
  - `import_falls_back_to_resume`: `{sessionCapabilities: {resume: {}}}` gives `Some(Resume)`.
  - `neither_method_gives_none`: `{}` gives `None` for both purposes.
- [ ] **Step 2: Write the failing integration tests** in `acp_session_reopen_test.rs`:
  - `continues_with_resume_when_offered`: `FAKE_ACP_RESUME` + `FAKE_ACP_CALL_LOG`, then `reopen(.., Continue)`. Assert `reopened_with == Some(ReopenMethod::Resume)`, the log contains `session/resume` and not `session/load`, and after `prompt("hi again")` the first agent text is `"echo: hi again"`.
  - `continues_with_load_and_drops_the_replay`: default fake agent. Assert `Some(Load)`, the log contains `session/load`, and the first agent text after a prompt is the echo (no "replayed history").
  - `refuses_to_continue_without_resume_or_load`: `FAKE_ACP_NO_LOAD`. The error contains "cannot resume".
- [ ] **Step 3: Run them to see them fail.** Run `cd src-tauri && cargo test --test acp_session_reopen_test && cargo test --lib reopen`. Expected: compile errors, since `reopen` and `ReopenMethod` are not defined.
- [ ] **Step 4: Implement `reopen.rs`.** `reopen` is `self.open(..)` with an `open_session` closure:
  - pick the method with `reopen_method`;
  - send `session/resume` or `session/load` with `{ sessionId, cwd, mcpServers: [] }` through `open_request`, with `route_on_answer(key, app, Some(acp_id), true)`;
  - build `StartedSession` from `response["modes"|"models"|"configOptions"]` with `reopened_with: Some(method)`.
  - `None` from `reopen_method` is `OpenError::Agent("This agent cannot resume earlier sessions")`.
  - `Import` + `Load` behaves like `Continue` + `Load` in this task; Task 2 adds the routed replay.
  Then:
  - delete `AcpManager::load` and update its two callers in `acp_manager_test.rs` to `reopen(.., ReopenPurpose::Continue)`;
  - rename the command and register it in `lib.rs`;
  - update the fake agent and its header comment list.
- [ ] **Step 5: Run the tests.** Run `cd src-tauri && cargo test --test acp_session_reopen_test --test acp_manager_test && cargo test --lib`. Expected: PASS.
- [ ] **Step 6: Commit.**
```bash
git add src-tauri/src/acp/manager/reopen.rs src-tauri/src/acp/manager.rs src-tauri/src/acp/commands.rs src-tauri/src/lib.rs src-tauri/tests/fixtures/fake_acp_agent.mjs src-tauri/tests/acp_manager_test.rs src-tauri/tests/common/mod.rs src-tauri/tests/acp_session_reopen_test.rs
git commit -m "feat: continue ACP sessions with session/resume when the agent offers it"
```

### Task 2: Import a session with its load replay routed to the app

**Files:**
- Modify: `src-tauri/src/acp/manager.rs` (`Routes.replaying`, `stop()`)
- Modify: `src-tauri/src/acp/manager/reopen.rs`
- Modify: `src-tauri/src/acp/manager/routing.rs`
- Modify: `src-tauri/src/acp/commands.rs`, `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/fixtures/fake_acp_agent.mjs`
- Test: `src-tauri/tests/acp_session_reopen_test.rs`

**Interfaces:**
- Consumes: Task 1's `reopen`, `ReopenPurpose::Import`, `common` helpers.
- Produces:
  - `Routes.replaying: HashMap<(u64, String), String>`, documented as in the spec;
  - `acp_import_session(session_id, cwd, profile_id, acp_session_id) -> Result<StartedSession, String>` (purpose `Import`);
  - fake agent flag `FAKE_ACP_SLOW_REPLAY`: load sends "earlier question" and "replayed history", waits 3 s, sends "late history", then answers.

- [ ] **Step 1: Write the failing tests:**
  - `import_routes_the_replay_to_the_app_session`: default fake agent, `reopen("s-imp", .., "fake-earlier", Import)`. Collect the `Update`s for `"s-imp"` received before the call returned: a `user_message_chunk` with text "earlier question", then an agent chunk "replayed history". `reopened_with == Some(Load)`.
  - `import_answers_requests_sent_during_the_replay`: `FAKE_ACP_EARLY_REQUESTS=<file>`, then Import. It returns `Ok` well before 20 s, and the file has both replies (`early-permission` with outcome `cancelled`, and `early-fs` with an error), like `answers_agent_requests_sent_while_a_session_loads`.
  - `stopping_an_import_mid_replay_drops_the_rest`: `FAKE_ACP_SLOW_REPLAY`. Run `reopen` on a thread; after the first update arrives, call `manager.stop("s-imp")`. No update with text "late history" arrives within 4 s. Then a second `reopen("s-imp2", .., "fake-earlier", Import)` on a default agent succeeds.
  - `import_with_only_resume_has_no_replay`: `FAKE_ACP_RESUME` + `FAKE_ACP_NO_LOAD`. `reopened_with == Some(Resume)`, and no update arrives for the app session within 1 s.
- [ ] **Step 2: Run them to see them fail.** Run `cd src-tauri && cargo test --test acp_session_reopen_test import`. Expected: the first test fails, since no updates are routed.
- [ ] **Step 3: Implement.**
  - For `Import` + `Load`, insert `replaying[(key, acp_id)] = app_id` before the request.
  - Remove it in the answer callback, in the same lock that inserts `by_acp_id` (give `route_on_answer` a `clears_replay: bool` parameter), and on any error before `register`.
  - `route_event`'s `session/update` arm looks up `by_acp_id`, then `replaying`; requests keep using only `by_acp_id`.
  - `Exited` drops `replaying` entries of the connection; `stop()` drops entries whose value is the app session id.
  - Add the command and register it.
- [ ] **Step 4: Run the tests.** Run `cd src-tauri && cargo test --test acp_session_reopen_test --test acp_manager_test`. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add src-tauri/src/acp/manager.rs src-tauri/src/acp/manager/reopen.rs src-tauri/src/acp/manager/routing.rs src-tauri/src/acp/commands.rs src-tauri/src/lib.rs src-tauri/tests/fixtures/fake_acp_agent.mjs src-tauri/tests/acp_session_reopen_test.rs
git commit -m "feat: import an ACP session with its history replayed into the chat"
```

### Task 3: List an agent's sessions for a folder

**Files:**
- Create: `src-tauri/src/acp/session_list.rs` (and `pub mod session_list;` in `acp/mod.rs`)
- Modify: `src-tauri/src/acp/manager.rs` (extract the error mapping from `open_request` into `pub(super) fn agent_error(method: &str, init: &Value, error: &Value) -> String`, used by both)
- Modify: `src-tauri/src/acp/commands.rs`, `src-tauri/src/lib.rs`
- Modify: `src-tauri/tests/fixtures/fake_acp_agent.mjs`
- Create: `src-tauri/tests/acp_session_list_test.rs`

**Interfaces:**
- Produces:
  - `pub const MAX_LIST_PAGES: usize = 10; pub const MAX_LISTED_SESSIONS: usize = 200;`
  - `#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")] pub struct ListedSession { pub acp_session_id: String, pub title: Option<String>, pub updated_at: Option<String> }`
  - `#[derive(Debug, Clone, PartialEq, Eq, Serialize)] #[serde(rename_all = "camelCase")] pub struct ListedSessions { pub sessions: Vec<ListedSession>, pub truncated: bool, pub incomplete: bool }`
  - `pub fn listed_session(info: &Value, cwd: &Path) -> Option<ListedSession>`
  - `AcpManager::list_sessions(&self, cwd: &str, launch: &AcpLaunch) -> Result<ListedSessions, String>`
  - Tauri `acp_list_sessions(profile_id, cwd) -> Result<ListedSessions, String>`, through `launch_in_workspace`
  - Fake agent flags:
    - `FAKE_ACP_LIST` adds `list: {}`.
    - `FAKE_ACP_LIST_PAGES=<file>` points to a JSON array of pages; each page is an array of `SessionInfo`. A missing cursor serves page 0 and `cursor: "page-<n>"` serves page n. The answer has `nextCursor: "page-<n+1>"` while pages remain. An unknown cursor gets `-32602`. Without the file there are no sessions.
    - `FAKE_ACP_LIST_FAIL_AT=<n>` makes page n answer `-32603`.
    - `FAKE_ACP_AUTH_REQUIRED` also refuses `session/list`.

- [ ] **Step 1: Write the failing unit tests** in `session_list.rs`:
  - `keeps_a_valid_entry`: `{sessionId: "a", cwd: <dir>, title: "Fix it", updatedAt: "2026-10-20T08:00:00Z"}` gives `Some` with every field.
  - `drops_bad_entries`: an empty id, an id of 257 characters, a non-string id, a relative `cwd`, a `cwd` of another folder, and a missing `cwd` each give `None`.
  - `cleans_titles`: `"  Fix\n\tthe\u{7}  bug "` gives `"Fix the bug"`. 300 `x`s are cut to 200. `"   "` gives `None`.
  - `checks_timestamps`: `2026-10-20T08:00:00Z`, `2026-10-20T08:00:00.123+07:00` and `2026-10-20T08:00:00-05:30` are kept. `2026-13-01T00:00:00Z`, `yesterday` and `2026-10-20` give `None`.
  - `matches_a_folder_through_a_symlink`: create `<tmp>/real` and `<tmp>/link -> real`; `cwd: <tmp>/link` matches `Path` `<tmp>/real`.
  - `matches_a_missing_folder_by_its_string`: a non-existent absolute path equal to `cwd` is kept.
- [ ] **Step 2: Write the failing integration tests** in `acp_session_list_test.rs` (pages written to a temp file):
  - `follows_every_page`: 3 pages of 2. Gives 6 sessions in agent order, with `truncated` and `incomplete` both false.
  - `stops_at_the_page_cap`: 11 pages of 1. Gives 10 sessions, `truncated`.
  - `stops_at_the_session_cap`: 3 pages of 100. Gives 200 sessions, `truncated`, and the call log shows exactly 2 `session/list`.
  - `keeps_earlier_pages_when_a_later_one_fails`: `FAIL_AT=1` with 2 pages. Gives page 0's sessions, `incomplete`.
  - `fails_when_the_first_page_fails`: `FAIL_AT=0`. `Err` containing "session/list failed".
  - `refuses_an_agent_without_list`: no `FAKE_ACP_LIST`. `Err("This agent cannot list its sessions")`.
  - `reports_a_needed_sign_in`: `FAKE_ACP_AUTH_REQUIRED`. `Err` starting with `ACP_AUTH_REQUIRED:`.
  - `drops_duplicates_and_other_folders`: the same id on two pages, plus an entry for `/elsewhere`. Only the first copy of the id is kept.
- [ ] **Step 3: Run them to see them fail.** Run `cd src-tauri && cargo test --test acp_session_list_test && cargo test --lib session_list`. Expected: compile errors.
- [ ] **Step 4: Implement.**
  - `list_sessions`:
    - `validate_cwd`, then `spawn_unrouted(cwd, launch, |_, _| {})`, then `initialize`;
    - check `sessionCapabilities.list`;
    - loop with `connection.request_raw_with("session/list", {cwd, cursor?}, SESSION_REQUEST_TIMEOUT, |_| {})`, stopping when the 120 s budget runs out (that sets `incomplete` when pages were read, else it is an error);
    - map errors with `agent_error`;
    - `connection.kill()` on every exit path.
  - `is_rfc3339`: a hand check of `YYYY-MM-DDTHH:MM:SS`, an optional `.digits`, then `Z` or `±HH:MM`, with month 1-12, day 1-31, hour 0-23, minute 0-59, second 0-60.
  - Add the command and register it.
- [ ] **Step 5: Run the tests.** Run `cd src-tauri && cargo test --test acp_session_list_test --test acp_manager_test && cargo test --lib`. Expected: PASS.
- [ ] **Step 6: Commit.**
```bash
git add src-tauri/src/acp/session_list.rs src-tauri/src/acp/mod.rs src-tauri/src/acp/manager.rs src-tauri/src/acp/commands.rs src-tauri/src/lib.rs src-tauri/tests/fixtures/fake_acp_agent.mjs src-tauri/tests/acp_session_list_test.rs
git commit -m "feat: list an ACP agent's sessions for a folder"
```

### Task 4: The probe says whether the agent can list sessions

**Files:**
- Modify: `src-tauri/src/acp/probe.rs`
- Test: `src-tauri/tests/acp_manager_test.rs` (next to the probe tests near line 559)

**Interfaces:**
- Produces: `ProbedAgent.can_list_sessions: bool`, serialized `canListSessions`.

- [ ] **Step 1: Write the failing tests:**
  - `probe_reports_session_listing_when_it_opens_a_session`: `FAKE_ACP_LIST`, `probe(.., true)` gives `can_list_sessions == true`; without the flag, `false`.
  - `probe_reports_session_listing_when_it_only_checks_the_sign_in`: `FAKE_ACP_LIST` + `FAKE_ACP_AUTH_STATUS=claude`, `probe(.., false)` gives `true`.
- [ ] **Step 2: Run them to see them fail.** Run `cd src-tauri && cargo test --test acp_manager_test probe_reports_session_listing`. Expected: compile error.
- [ ] **Step 3: Implement.** Set the field from `init["agentCapabilities"]["sessionCapabilities"]["list"].is_object()` in both `ProbedAgent` literals.
- [ ] **Step 4: Run the tests.** Run `cd src-tauri && cargo test --test acp_manager_test probe`. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add src-tauri/src/acp/probe.rs src-tauri/tests/acp_manager_test.rs
git commit -m "feat: report from the probe whether an agent can list its sessions"
```

### Task 5: The UI reopens through the backend's choice

**Files:**
- Modify: `src/hooks/useAcpSessions.ts`
- Modify: `src/hooks/session-engine/useAcpEngine.ts` (`resume`, `retryAfterSignIn`)
- Create: `src/lib/session-list.ts`
- Modify: `src/test/setup.ts`, `src/test/acp-app.test.tsx`, `src/test/composer-controls.test.ts`, `src/test/use-acp-engine-sign-in.test.tsx`, `src/test/use-acp-sessions.test.tsx`
- Create: `src/test/session-list.test.ts`

**Interfaces:**
- Consumes: the Tauri commands of Tasks 1-3.
- Produces:
  - `AcpSessionInfo.canReopen: boolean`, replacing `canLoad`. It is `loadSession === true || isObject(sessionCapabilities.resume)`.
  - `AcpSessionInfo.reopenedWith?: 'resume' | 'load'`.
  - In `useAcpSessions`, `reopen` replaces `load`:
    - `reopen(sessionId, cwd, profileId, acpSessionId): Promise<AcpSessionInfo>` calls `acp_reopen_session`;
    - `importSession(sessionId, cwd, profileId, acpSessionId): Promise<AcpSessionInfo>` calls `acp_import_session`;
    - `listSessions(profileId, cwd): Promise<ListedSessions>` calls `acp_list_sessions` and runs `toListedSessions`.
  - `src/lib/session-list.ts`:
    - `interface ListedSession { acpSessionId: string; title?: string; updatedAt?: string }`;
    - `interface ListedSessions { sessions: ListedSession[]; truncated: boolean; incomplete: boolean }`;
    - `toListedSessions(raw: unknown): ListedSessions` drops malformed entries;
    - `sessionsToOffer(listed: readonly ListedSession[], sessions: readonly Session[]): ListedSession[]` drops every `acpSessionId` some session holds and sorts newest `updatedAt` first, with undated entries last in agent order.

- [ ] **Step 1: Write the failing tests:**
  - In `session-list.test.ts`:
    - `toListedSessions` keeps valid entries, drops a missing or non-string `acpSessionId`, and defaults `truncated` and `incomplete` to false;
    - `sessionsToOffer` drops an id held by an archived session and by a session of another agent, orders `2026-10-20` before `2026-10-19`, and puts undated entries last.
  - In `use-acp-sessions.test.tsx`: `canReopen` is true for `{loadSession: true}`, for `{sessionCapabilities: {resume: {}}}`, and false for `{}`; `reopenedWith` is read.
  - In `use-acp-engine-sign-in.test.tsx`, new case `continues a resume-only agent after a sign-in`: canned capabilities `{sessionCapabilities: {resume: {}}}`, a session refused at a prompt, then a sign-in. The retry invokes `acp_reopen_session`, not `acp_start_session`, and writes no handoff.
- [ ] **Step 2: Run them to see them fail.** Run `pnpm vitest run src/test/session-list.test.ts src/test/use-acp-sessions.test.tsx src/test/use-acp-engine-sign-in.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Make the renames.
  - `setup.ts` answers `acp_reopen_session` and `acp_import_session` like `acp_load_session` did, and `acp_list_sessions` with `{ sessions: [], truncated: false, incomplete: false }`, overridable through `window.__FAKE_ACP_LIST__` when set.
  - Update the four existing test files for the new names; behaviour is unchanged.
- [ ] **Step 4: Run the tests.** Run `pnpm vitest run src/test && pnpm lint`. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add src/hooks/useAcpSessions.ts src/hooks/session-engine/useAcpEngine.ts src/lib/session-list.ts src/test/setup.ts src/test/acp-app.test.tsx src/test/composer-controls.test.ts src/test/use-acp-engine-sign-in.test.tsx src/test/use-acp-sessions.test.tsx src/test/session-list.test.ts
git commit -m "feat: reopen ACP sessions through the backend's resume or load"
```

### Task 6: Fold a load replay into chat messages

**Files:**
- Modify: `src/lib/acp-events.ts`
- Test: `src/test/acp-events.test.ts`

**Interfaces:**
- Produces: `applyReplayUpdate(messages: ChatMessage[], update: unknown, ctx: AcpReducerContext): ChatMessage[]`.
  - A `user_message_chunk` with text closes an open agent reply (`isComplete: true`) and appends a user message. When the last message is a user message from the replay with the same `messageId` (or neither has one), it extends it instead.
  - A non-text content block becomes its `uri`'s file name (`fileNameOf` from `lib/attachments`).
  - Anything else goes to `applyAcpUpdate`.
  - A replayed user message stores `messageId`, when given, on the `ChatMessage` as `replayId?: string`. Add that optional field to `ChatMessage` in `src/types/index.ts`.

- [ ] **Step 1: Write the failing tests** (`describe('applyReplayUpdate')`):
  - `user, agent, user, agent` gives four messages in order, the agent ones complete except the last.
  - Two user chunks with the same `messageId` give one user message with the joined text.
  - Two user chunks with different `messageId`s give two user messages.
  - An empty user chunk changes nothing.
  - `agent_message_chunk` and `tool_call` behave as in `applyAcpUpdate`.
  - Review Focus 3: a replayed `tool_call` with status `in_progress` and a permission request card, followed by `closeTurn`, leave the last reply `isComplete: true` and the card `rejected`.
- [ ] **Step 2: Run them to see them fail.** Run `pnpm vitest run src/test/acp-events.test.ts`. Expected: FAIL (`applyReplayUpdate` is not exported).
- [ ] **Step 3: Implement** `applyReplayUpdate` and the `replayId` field. `persistence.ts` keeps unknown message fields as they are; check that, and if it strips them, keep `replayId` only when it is a string.
- [ ] **Step 4: Run the tests.** Run `pnpm vitest run src/test/acp-events.test.ts src/test/persistence.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add src/lib/acp-events.ts src/types/index.ts src/test/acp-events.test.ts
git commit -m "feat: fold an ACP load replay into chat messages"
```

### Task 7: Note on an imported session whose history stays in the agent

**Files:**
- Create: `src/lib/relative-time.ts`, `src/components/chat/HistoryElsewhereNote.tsx`
- Modify: `src/components/ChatCanvas.tsx` (use `formatRelativeTime` from the lib, delete its private copy)
- Modify: `src/types/index.ts` (`Session.historyElsewhere?: boolean`), `src/lib/persistence.ts` (`withValidFields`)
- Modify: `src/App.tsx` (render ChatCanvas also when `activeSession.historyElsewhere`, and put the note in its `header` above the `WorkspaceSummary`)
- Test: `src/test/relative-time.test.ts`, `src/test/chat-canvas.test.tsx`, `src/test/persistence.test.ts`

**Interfaces:**
- Produces:
  - `formatRelativeTime(timestamp: number, now: number = Date.now()): string`, with the same output as today's ChatCanvas helper ("Just now", "5 minutes ago", "1 hour ago", "3 days ago"). A future timestamp gives "Just now".
  - `HistoryElsewhereNote({ agentName }: { agentName: string })`, which renders "Earlier messages stay in {agentName}. They are not shown here." in `text-fg-muted` inside a `role="note"` element.

- [ ] **Step 1: Write the failing tests:**
  - `relative-time.test.ts` covers each unit boundary (59 s, 60 s, 59 min, 60 min, 23 h, 24 h) with a fixed `now`, plus a future timestamp.
  - `chat-canvas.test.tsx`: a `header` containing `HistoryElsewhereNote` with "Claude Code" shows the exact copy, and there is no note without it.
  - `persistence.test.ts`: `historyElsewhere: true` survives a load, and `historyElsewhere: "yes"` is dropped while the session itself is kept.
- [ ] **Step 2: Run them to see them fail.** Run `pnpm vitest run src/test/relative-time.test.ts src/test/chat-canvas.test.tsx src/test/persistence.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Run `pnpm vitest run src/test && pnpm lint`. Expected: PASS, including `design-tokens.test.ts`.
- [ ] **Step 5: Commit.**
```bash
git add src/lib/relative-time.ts src/components/chat/HistoryElsewhereNote.tsx src/components/ChatCanvas.tsx src/types/index.ts src/lib/persistence.ts src/App.tsx src/test/relative-time.test.ts src/test/chat-canvas.test.tsx src/test/persistence.test.ts
git commit -m "feat: note when an imported session's history stays in the agent"
```

### Task 8: The draft's list of the agent's sessions

**Files:**
- Modify: `src/hooks/useAgentProbe.ts`, `src/hooks/useDraftAgentCheck.ts`
- Create: `src/hooks/useAgentSessionList.ts`, `src/components/workspace/AgentSessionList.tsx`
- Test: `src/test/use-agent-probe.test.tsx`, `src/test/use-draft-agent-check.test.tsx`, `src/test/use-agent-session-list.test.tsx`, `src/test/agent-session-list.test.tsx`

**Interfaces:**
- Consumes: Task 5's `listSessions`, `ListedSession`, `ListedSessions` and `sessionsToOffer`; Task 7's `formatRelativeTime`; `parseAuthRequired` (`lib/acp-auth`); `AgentAuth['requestSignIn']`.
- Produces:
  - `useAgentProbe`'s `onProbed(profileId, options, facts: ProbeFacts)` with `interface ProbeFacts { signInChecked: boolean; canListSessions: boolean }`, replacing the boolean third argument.
  - `useDraftAgentCheck(...)` returns `{ isProbing, canListSessions: (profileId: string) => boolean }`, held in a state map keyed by profile id and set on every probe answer.
  - `type SessionListState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'loaded'; sessions: ListedSession[]; truncated: boolean; incomplete: boolean } | { kind: 'failed'; message: string }`.
  - `useAgentSessionList(deps: { profileId: string | undefined; cwd: string | undefined; sessions: readonly Session[]; listSessions: (profileId: string, cwd: string) => Promise<ListedSessions>; requestSignIn: AgentAuth['requestSignIn'] }): { state: SessionListState; load: () => void; importError: string | null; setImportError: (message: string | null) => void }`.
    - The list is filtered through `sessionsToOffer` whenever `sessions` changes.
    - Everything resets to idle when `profileId` or `cwd` changes, and an answer for an older (profile, cwd) is ignored.
    - An `ACP_AUTH_REQUIRED` failure calls `requestSignIn(profileId, cwd, methods)` and goes back to idle.
  - `AgentSessionList(props: { agentName: string; state: SessionListState; importError: string | null; onLoad: () => void; onImport: (listed: ListedSession) => void })`, using the exact copy from Global Constraints.
    - Each session is a `Button` row showing its title (or "Untitled session") and its relative time.
    - "Try again" calls `onLoad`.

- [ ] **Step 1: Write the failing tests:**
  - **`use-agent-probe.test.tsx`**: a probe answer with `canListSessions: true` reaches `onProbed` as `facts.canListSessions === true`; a missing field gives false.
  - **`use-draft-agent-check.test.tsx`**: `canListSessions('qwen')` is true after such a probe and false before it.
  - **`use-agent-session-list.test.tsx`**:
    - idle, then `load()`, then loading, then loaded with offered sessions only;
    - a held id disappears after `sessions` gains it;
    - a rejection "boom" gives failed "boom";
    - an `ACP_AUTH_REQUIRED:[{"id":"browser","name":"Browser"}]` rejection calls `requestSignIn` and goes back to idle;
    - Review Focus 1: `load()` for agent A, then a switch to agent B, then A's promise resolving leaves the state idle for B.
  - **`agent-session-list.test.tsx`**:
    - the idle button reads "Continue a session from Claude Code" and calls `onLoad`;
    - loading shows "Asking Claude Code for its sessions…";
    - loaded and empty shows "Claude Code has no other sessions in this folder.";
    - loaded shows the rows, and clicking one calls `onImport` with it;
    - `truncated` and `incomplete` show their lines;
    - failed shows the message and "Try again";
    - `importError` is shown;
    - every button has the `focus-ring` class.
- [ ] **Step 2: Run them to see them fail.** Run `pnpm vitest run src/test/use-agent-probe.test.tsx src/test/use-draft-agent-check.test.tsx src/test/use-agent-session-list.test.tsx src/test/agent-session-list.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Run `pnpm vitest run src/test && pnpm lint`. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add src/hooks/useAgentProbe.ts src/hooks/useDraftAgentCheck.ts src/hooks/useAgentSessionList.ts src/components/workspace/AgentSessionList.tsx src/test/use-agent-probe.test.tsx src/test/use-draft-agent-check.test.tsx src/test/use-agent-session-list.test.tsx src/test/agent-session-list.test.tsx
git commit -m "feat: list an agent's other sessions in the new-session draft"
```

### Task 9: Import a listed session, end to end, and document it

**Files:**
- Modify: `src/lib/session-start.ts` (`SessionSpec.acpSessionId`, `importedSessionSpec`)
- Modify: `src/hooks/session-engine/useAcpEngine.ts` (`LaunchOptions.onOpenError`, `importSession`, the replaying ref in `onUpdate`)
- Create: `src/hooks/useSessionImport.ts`
- Modify: `src/components/workspace/NewSessionView.tsx` (`sessionList?: ReactNode` slot below the summary)
- Modify: `src/App.tsx` (wiring only)
- Modify: `CHANGELOG.md` (Unreleased), `CLAUDE.md`
- Test: `src/test/session-start.test.ts`, `src/test/session-import.test.tsx` (new), `src/test/new-session.test.tsx`

**Interfaces:**
- Consumes:
  - Task 5's `importSession` wrapper and `AcpSessionInfo.reopenedWith`;
  - Task 6's `applyReplayUpdate`;
  - Task 7's `historyElsewhere`;
  - Task 8's `useAgentSessionList`, `AgentSessionList` and `useDraftAgentCheck().canListSessions`;
  - App's `recordSession`, `openNewSession`, `removeSessionFrom` (`lib/session-helpers`), `removeTranscript`, `navigation.remove`, `signIn.auth.requestSignIn`, `startChoices` and `setAcpChoices(NO_CHOICES)`.
- Produces:
  - `importedSessionSpec(listed: ListedSession, agent: AgentProfile, cwd: string, now: number = Date.now()): SessionSpec`.
    - The name is `titleFromPrompt(listed.title)` when that is non-empty.
    - Otherwise it is `` `${agent.name} session, ${new Date(listed.updatedAt ?? now).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` ``, for example "Claude Code session, 20 Oct".
    - The spec also carries `acpSessionId`, and `newSessionRecord` copies `spec.acpSessionId ?? null` into the record.
  - `LaunchOptions.onOpenError?: (error: unknown) => void`. When set, `launch`'s catch runs:
    - `if (isStopped) return true`;
    - takes the message back out;
    - `elicitations.abandon`;
    - then calls `onOpenError(error)` and returns false, without marking the session terminated and without the sign-in hand-back.
  - `useAcpEngine().importSession(session: Session, choices: AcpChoices, onOpenError: (error: unknown) => void): Promise<boolean>`.
    - It runs `launch` with `action: 'import'` and `applySafeMode: true`.
    - While it opens, the session id is in a `replayingRef` set, and `onUpdate` folds with `applyReplayUpdate` instead of `applyAcpUpdate`.
    - After the open it runs `updateMessages(closeTurn)` and, when `info.reopenedWith === 'resume'`, `patchSession(id, { historyElsewhere: true })`.
    - The ref is cleared in `finally`.
  - `useSessionImport(deps: { sessions: readonly Session[]; agent: AgentProfile | undefined; cwd: string | undefined; acp: Pick<AcpEngine, 'importSession'>; choices: AcpChoices; onChoicesUsed: () => void; recordSession: (spec: SessionSpec) => Session; openSession: (sessionId: string) => void; discardSession: (sessionId: string) => void; openNewSession: (path: string, agentId: string) => void; requestSignIn: AgentAuth['requestSignIn']; onImportError: (message: string) => void }): (listed: ListedSession) => void`.
    - A listed id that a session already holds goes to `openSession(id)`.
    - Otherwise it calls `recordSession`, then `acp.importSession(..)`.
    - On error it calls `discardSession` and `openNewSession(cwd, agent.id)`, then either `requestSignIn` (for a sign-in error) or `onImportError(`Could not open the session: ${message}`)`.

- [ ] **Step 1: Write the failing tests:**
  - **`session-start.test.ts`**:
    - the title "Fix the login bug" is used;
    - an empty title, a whitespace-only title and a missing title each give "Claude Code session, 20 Oct" (`updatedAt: '2026-10-20T08:00:00Z'`);
    - a multi-line markdown title gives one line (Review Focus 5);
    - the spec carries `acpSessionId`.
  - **`session-import.test.tsx`**, rendering `App` with the fake store:
    - the draft with `canListSessions` shows the button;
    - with a worktree on, the button is not shown;
    - pressing the button, then a row, with `acp_import_session` canned to emit replay `acp-event`s (user "earlier question", agent "replayed history") before resolving, shows both messages in the chat, the session in the sidebar under its title, and the composer's picked model applied (`acp_set_config_option` invoked);
    - Review Focus 2: `acp_import_session` rejecting "session/load failed: Unknown session" leaves no new session in the sidebar or store and no transcript, returns to the draft, and shows "Could not open the session: session/load failed: Unknown session";
    - rejecting with `ACP_AUTH_REQUIRED:[...]` opens the sign-in panel;
    - `reopenedWith: 'resume'` shows "Earlier messages stay in Claude Code. They are not shown here.";
    - a listed id equal to an existing session's `acpSessionId` opens that session, and `acp_import_session` is not invoked;
    - Review Focus 4: deleting the imported session while `acp_import_session` is still pending, then emitting a replay event, writes no transcript for it.
  - **`new-session.test.tsx`**: the `sessionList` slot renders below the workspace summary.
- [ ] **Step 2: Run them to see them fail.** Run `pnpm vitest run src/test/session-start.test.ts src/test/session-import.test.tsx src/test/new-session.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `App.tsx`:
    - `const sessionList = useAgentSessionList({ profileId: isNewSessionDraft ? newSessionAgent?.id : undefined, cwd: activeWorkspace?.path, sessions, listSessions: acp.listSessions, requestSignIn: signIn.auth.requestSignIn })`;
    - `const importListed = useSessionImport({...})`;
    - `NewSessionView` gets `sessionList` only when `newSessionAgent && agentCheck.canListSessions(newSessionAgent.id) && !(isWorktreeOn && canUseWorktree)`.
  - Expose `listSessions` from the engine, passing `acp.listSessions` through.
  - `discardSession` is `navigation.remove(id)`, then `updateState((p) => removeSessionFrom(p, id))`, then `removeTranscript(id)`.
  - Docs:
    - `CHANGELOG.md` Unreleased: "Zorvo continues a session with the agent's own resume when it offers one, and you can continue a session started outside Zorvo (for example in the agent's CLI) from the new-session screen."
    - `CLAUDE.md`: in **ACP backend**, say `reopen` picks resume or load (`acp/manager/reopen.rs`). Add a **Session list and import** paragraph naming `acp/session_list.rs` (all pages in one process, 10 pages / 200 sessions, validated `SessionInfo`), the notification-only `replaying` map, `useAgentSessionList`, `AgentSessionList`, `useSessionImport`, `applyReplayUpdate` and `historyElsewhere`. Update the `fake_acp_agent.mjs` note with the new flags.
- [ ] **Step 4: Run the tests.** Run `pnpm vitest run src/test && pnpm lint`. Expected: PASS. `wc -l src/App.tsx src-tauri/src/acp/manager.rs` both report under 800 lines.
- [ ] **Step 5: Commit.**
```bash
git add src/lib/session-start.ts src/hooks/session-engine/useAcpEngine.ts src/hooks/useSessionImport.ts src/components/workspace/NewSessionView.tsx src/App.tsx CHANGELOG.md CLAUDE.md src/test/session-start.test.ts src/test/session-import.test.tsx src/test/new-session.test.tsx
git commit -m "feat: continue a session started outside Zorvo from the new-session draft"
```

### Task 10: Full verification and PR

- [ ] **Step 1: Run every gate.** Run `pnpm lint && pnpm test && pnpm build`, then `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`. Expected: all green. Fix anything red in the task that owns it, as a `fix:` commit.
- [ ] **Step 2: Whole-branch review.** Review `git diff origin/main...HEAD` against the spec and this plan's Review Focus; fix the findings.
- [ ] **Step 3: Push and open the PR.** Run `git push -u origin feat/acp-session-list-resume`, then `gh pr create --base main` with a summary, the spec link, the test plan, and the known limits from the spec. Do not merge.
