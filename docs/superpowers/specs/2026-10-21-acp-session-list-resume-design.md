# ACP session list and resume — design

Date: 2026-10-21
Branch: `feat/acp-session-list-resume` (worktree `.claude/worktrees/acp-session-list-resume`), from `main` at 416396c.

## Goal

Zorvo supports two stable ACP v1 methods:

- `session/resume` reopens an ended session without the agent replaying its history. Zorvo
  keeps its own transcript and today throws away the replay `session/load` sends, so resume
  is the cheaper way to continue a session.
- `session/list` lets the user continue, in Zorvo, a session started outside it (for example
  in the agent's own CLI) in the same folder, with its history shown.

## Decisions

| Topic | Decision |
|---|---|
| Continuing a Zorvo session | `session/resume` when the agent offers `sessionCapabilities.resume`, else `session/load` (replay dropped, as today). No fallback chain: a failed resume is reported like a failed load is today, and the sign-in retry still turns an "unknown session" error into a fresh session plus handoff. |
| Rule of thumb | **Load when Zorvo needs the history, resume when it already has it.** |
| What `session/list` is for | Importing sessions Zorvo does not know: the agent's sessions for the draft's folder whose `acpSessionId` no Zorvo session holds. |
| Where it shows | The new-session draft (`NewSessionView`): a **Continue a session from <Agent>** button below the workspace summary. The agent is asked only when the button is pressed. The button shows only when the draft's probe saw `sessionCapabilities.list`, and is hidden while the draft is set to a new worktree. |
| Importing | With `loadSession`: `session/load`, and its replay is folded into the transcript, so the user sees the conversation. Without it: `session/resume`, and the chat shows a note that earlier messages stay in the agent. |
| Title and record | The agent's `title` (cleaned, through `titleFromPrompt`), else "<Agent> session, 20 Oct" from `updatedAt` (or the import date). An ordinary `Session` with `profileId`, the draft's `cwd` and `acpSessionId`; `namedByUser` stays false, so later `session_info_update`s rename it. |
| Sessions Zorvo let go | Shown. A session deleted in Zorvo, the pre-rewind session of a rewound one, and a probe session the agent could only close (not delete) are real sessions of the agent and can be imported again. |
| Paging | One backend call reads every page in one agent process, following `nextCursor` up to 10 pages or 200 sessions, then ends the agent. Cursors never leave the backend and are never reused across processes. No **Show more** button. |
| Probe | `ProbedAgent` gains `canListSessions`, read from `initialize` on both probe paths. Throwaway probe sessions are deleted (`session/delete`), so they do not show in the list. |
| Fork | Unchanged. Native and handoff forks record their `acpSessionId`, so they never show in the list. An imported session can be forked like any other. |

## Constraints

- **Trust boundary.** The webview sends only an agent id, a folder, app session ids and the
  `acpSessionId` it got from the list. The backend builds the command line (`launch_for`) and
  decides resume versus load from `initialize`. Every new command goes through
  `launch_in_workspace`, so `files::ensure_known_workspace` checks the folder.
- **Network.** No new requests: the webview makes none, and the backend only runs the agent.
- **Agent data is untrusted.** Each `SessionInfo` is validated in Rust before the UI sees it.
  Paths from the agent are only compared, never used to run or read anything.
- `mcpServers: []` is sent on resume as on new/load/fork. `additionalDirectories` is never sent.
- **Design system.** Tokens only, `ui/` primitives, `focus-ring` on every control,
  sentence-case copy that names the agent.
- Source files stay under 800 lines. `manager.rs` is 751 lines today, so `reopen` and the
  `replaying` bookkeeping go in a new `acp/manager/reopen.rs` (like `elicitation_routes.rs`)
  and the list code in `acp/session_list.rs`. `App.tsx` only gains wiring.
- Test-first; `pnpm lint`, `pnpm test`, `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings` and `cargo test` green.

## The ACP rules this follows

From `protocol/v1/session-setup`, `protocol/v1/session-list` and the v1 schema:

- `session/resume` is allowed only when `agentCapabilities.sessionCapabilities.resume` is
  present. Params: `sessionId`, `cwd` (absolute), `mcpServers`, optional
  `additionalDirectories` (only when the agent advertises them). The agent **must not**
  replay history; it answers once the session is ready. The answer may carry `modes` and
  `configOptions`.
- `session/load` is allowed only when `loadSession` is `true`. The agent replays the whole
  conversation as `session/update`s (`user_message_chunk`, `agent_message_chunk`, tool calls,
  …, optionally with `messageId`s), then answers.
- `session/list` is allowed only when `sessionCapabilities.list` is present. Params are
  optional `cwd` (absolute; only sessions with that `cwd`) and `cursor`. The answer is
  `{ sessions: SessionInfo[], nextCursor? }`. A missing `nextCursor` is the end. Cursors are
  opaque: not parsed, changed or persisted. Agents should reject an invalid cursor.
- `SessionInfo` is `{ sessionId, cwd, title?, updatedAt?, additionalDirectories?, _meta? }`;
  `updatedAt` is ISO 8601.

## Backend (Rust)

### Reopening: one path, the backend picks the method

`AcpManager::load` becomes `reopen(app_session_id, cwd, launch, acp_session_id, purpose)`:

```rust
pub enum ReopenPurpose {
    /// A Zorvo session with its transcript: resume, else load with the replay dropped.
    Continue,
    /// A session from the agent's list: load with the replay routed, else resume.
    Import,
}
```

| Purpose | `resume` offered | `loadSession` offered | Method | Replay |
|---|---|---|---|---|
| Continue | yes | any | `session/resume` | none |
| Continue | no | yes | `session/load` | dropped (as today) |
| Import | any | yes | `session/load` | routed to the app session |
| Import | yes | no | `session/resume` | none |
| either | no | no | error "This agent cannot resume earlier sessions" | |

`StartedSession` gains `reopened_with: Option<ReopenMethod>` (`"resume"` or `"load"`;
absent for start and fork), so the UI knows when an import has no history to show. Resume
answers carry no `models`; `models` is then `Null`, which the UI already handles.

**Routing the replay without risking a deadlock.** `route_event` uses `by_acp_id` for both
notifications and requests. If the import's route went into `by_acp_id` before `session/load`,
a `session/request_permission` sent during the replay would reach the UI as a card. It could
not be answered, since `respond_permission` looks the session up in `sessions`, which is
filled only after load answers, so the agent and Zorvo would wait on each other until
`HANDSHAKE_TIMEOUT`.

So `Routes` gains a separate map:

```rust
/// (connection key, acp session id) -> app session id, for an import whose
/// `session/load` is replaying: only its `session/update`s are routed.
replaying: HashMap<(u64, String), String>,
```

- It is filled just before `session/load` is sent (the id is known) and emptied when load
  answers (before `register`), when it fails, in `stop()` and on `Exited`.
- `route_event` routes a `session/update` through `by_acp_id`, then `replaying`. Requests
  still use only `by_acp_id`, so a request during the replay is answered `cancelled`
  (permission), refused (others) or handled by the `opening` map (elicitation), as during
  any open today.

### Commands

- `acp_load_session` is renamed to **`acp_reopen_session`** (purpose `Continue`).
- **`acp_import_session(sessionId, cwd, profileId, acpSessionId)`** (purpose `Import`).
- **`acp_list_sessions(profileId, cwd)`**.

All three are `#[tauri::command(async)]` and go through `launch_in_workspace`, whose folder
check is already covered by `commands.rs` unit tests; the commands add no logic of their own.

### Listing (`acp/session_list.rs`)

```rust
pub struct ListedSessions {
    pub sessions: Vec<ListedSession>, // { acp_session_id, title: Option<String>, updated_at: Option<String> }
    pub truncated: bool,   // the page or session cap was reached
    pub incomplete: bool,  // a later page failed; the earlier ones are kept
}
```

`AcpManager::list_sessions(cwd, launch)`:

1. `validate_cwd(cwd)`, `spawn_unrouted`, then `initialize` (`HANDSHAKE_TIMEOUT`).
2. Without `sessionCapabilities.list`: error `"This agent cannot list its sessions"` (worded
   like the existing "This agent cannot resume earlier sessions").
3. Loop `session/list { cwd, cursor }`: `SESSION_REQUEST_TIMEOUT` per page, a 120 s budget
   after `initialize`, at most `MAX_LIST_PAGES = 10` pages and `MAX_LISTED_SESSIONS = 200`
   sessions. Stop at a missing or empty `nextCursor`.
4. A failure on the first page is the command's error. An auth-required error becomes
   `ACP_AUTH_REQUIRED:` + methods through `is_auth_required` and `auth_required_error`, in a
   small helper next to `open_request`. A failure on a later page sets `incomplete`.
5. Kill the agent.

Validation of each `SessionInfo`. Entries that fail are dropped:

- `sessionId` is a non-empty string, at most 256 characters, and not a duplicate.
- `cwd` is an absolute path equal to the requested folder: first as strings, else after
  canonicalising both when both canonicalise. This covers symlinks such as `/tmp` →
  `/private/tmp`. A path that no longer exists falls back to the string comparison.
- `title`: control characters removed, whitespace collapsed, cut to 200 characters; empty
  becomes `None`.
- `updatedAt`: kept only when it has the RFC 3339 shape
  (`YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`, with in-range fields), checked by a small
  function in `session_list.rs`. No new crate; the UI turns it into a `Date`.

### Probe

`ProbedAgent` gains `can_list_sessions: bool`, set from
`init["agentCapabilities"]["sessionCapabilities"]["list"].is_object()` on both paths: sign-in
only, and throwaway session. A probe that fails (signed out) reports nothing, so the button
stays hidden until the agent is signed in and probed again.

## Frontend

### Continuing

- `AcpSessionInfo.canLoad` becomes **`canReopen`**: `loadSession === true` or
  `sessionCapabilities.resume` is an object.
- `retryAfterSignIn` uses `canReopen`, so an agent that only offers resume is continued, not
  restarted with a handoff.
- `useAcpSessions.load` becomes `reopen` (`acp_reopen_session`), and gains
  `importSession` (`acp_import_session`) and `listSessions` (`acp_list_sessions`).
  `toInfo` also reads `reopenedWith`.

### The list in the draft

- **`src/hooks/useAgentSessionList.ts`**: state
  `idle | loading | loaded {sessions, truncated, incomplete} | failed {message}` for the
  draft's (agent, folder). `load()` calls `acp_list_sessions`. The result drops every
  `acpSessionId` some Zorvo session already holds (archived ones too, any agent) and is
  sorted newest `updatedAt` first, with undated sessions last. It is kept in memory only and
  reset when the draft's agent or folder changes. An `ACP_AUTH_REQUIRED` failure calls
  `auth.requestSignIn(profileId, cwd, methods)` (the draft's sign-in panel) instead of
  showing an error.
- **`canListSessions`** travels from `useAgentProbe` through `useDraftAgentCheck` to the draft.
  It is in memory only, not saved to `agentOptions`, since it can change with the agent's
  version.
- **`src/components/workspace/AgentSessionList.tsx`**, rendered by `NewSessionView`:

| State | Shows |
|---|---|
| idle | Button **Continue a session from Claude Code** |
| loading | "Asking Claude Code for its sessions…" |
| loaded, none | "Claude Code has no other sessions in this folder." |
| loaded | One button per session: title, and `updatedAt` as relative time ("2 hours ago") |
| truncated | Extra line: "Showing the 200 most recent sessions." |
| incomplete | Extra line: "Some sessions could not be listed." |
| failed | The error and **Try again** |

- **`src/lib/relative-time.ts`**: `formatRelativeTime(iso, now)` with
  `Intl.RelativeTimeFormat("en", { numeric: "auto" })`.

### Importing

- **`importedSessionRecord(listed, agent, cwd, now)`** in `lib/session-start.ts` builds the
  `Session` through `newSessionRecord`, with the title rule above and `acpSessionId`.
- **`useAcpEngine.importSession(session, choices)`**:
  `launch(session, () => acp.importSession(...), { action: 'import', choices, applySafeMode: true, onOpenError })`.
  The draft's model and mode picks apply, as on a start.
- **`LaunchOptions.onOpenError`** (new, optional). When set, it replaces `launch`'s failure
  branch, which today marks the session `terminated` and, on a sign-in error, ties the
  sign-in to that session. For an import it:
  - removes the record and its transcript (`removeSessionFrom`);
  - goes back to the draft of the same workspace (not `mostRecentSessionId`, which
    `deleteSession` would pick);
  - on a sign-in error calls `auth.requestSignIn`, else shows the error in the list.
- **Order.** The record is added and made active, so the replay has somewhere to go, then
  `acp_import_session` is invoked. A list entry whose `acpSessionId` a session already holds
  (a double click) opens that session instead.
- **Replay folding.** `applyReplayUpdate(prev, update, ctx)` in `lib/acp-events.ts`:
  - `user_message_chunk` closes an open agent message (`isComplete`) and starts a user
    message, or extends one when the previous chunk was also the user's (same `messageId`
    when given). Only text content is shown; other blocks become their file name, as
    attachments do.
  - Any other update goes to `applyAcpUpdate`.
  - The engine uses it for the session being imported (a ref set during `importSession`),
    then runs `closeTurn` once the import answers.
  - Nothing has to be silenced: `onAttention` fires only on permission, elicitation and turn
    end, and `hasUnread` only when a busy session stops while another is open, while the
    import is the open session.
- **Import without history.** When an import answers `reopenedWith: "resume"`, the session
  gets `historyElsewhere: true`, a new optional `Session` field validated in
  `lib/persistence.ts` (non-booleans dropped; no `STATE_VERSION` bump). `ChatCanvas` then
  shows above the transcript: "Earlier messages stay in Claude Code. They are not shown
  here." It is not a `ChatMessage`, so it never goes into a handoff or a rewind.

### Known limits (accepted)

- For a `historyElsewhere` session, a handoff fork and a rewind carry only the messages Zorvo
  shows. A native fork carries the agent's full history.
- A `session_info_update` that arrives during the replay may be missed, because `onUpdate`
  reads `sessions` from its closure before the new record is in it. The title from the list
  is already set.
- Pressing **Continue…** while the draft probe runs starts a second, short-lived agent
  process.

## Error handling

| Case | Result |
|---|---|
| Resume or load fails while continuing | As today: "Failed to resume <Agent>: …", session ended; the sign-in retry turns an unknown session into a fresh one plus handoff. |
| Agent offers neither resume nor load | "This agent cannot resume earlier sessions" (as today). |
| Agent has no `list` | "This agent cannot list its sessions" (rare, since the button is hidden). |
| List needs a sign-in | The draft's sign-in panel opens. |
| First list page fails or times out | Error in the list, **Try again**. |
| A later page fails | The pages already read, plus "Some sessions could not be listed." |
| Malformed entries | Dropped in Rust. |
| Import fails (any reason) | Record and transcript removed, back to the draft; sign-in panel or error in the list. |
| Import stopped during the replay | `stop()` clears `replaying`; later updates are dropped; the UI's stopped set ignores the rest. |

## Testing

### Rust

`fake_acp_agent.mjs` gains flags that **add** capabilities. The default stays `loadSession`,
`fork` and `delete`, so the existing load tests keep testing load.

| Flag | Effect |
|---|---|
| `FAKE_ACP_RESUME` | Advertises `sessionCapabilities.resume`; `session/resume` answers with modes and no replay. |
| `FAKE_ACP_LIST` | Advertises `sessionCapabilities.list`. |
| `FAKE_ACP_LIST_PAGES` | Names a JSON file with an array of pages. Cursors are `page-<n>`; an unknown cursor gets `-32602`. |
| `FAKE_ACP_LIST_FAIL_AT=<n>` | Page `n` fails. |
| `FAKE_ACP_CALL_LOG` | Appends each method received to the file it names, one per line, so a test can tell resume from a dropped-replay load. |
| `FAKE_ACP_SLOW_REPLAY` | `session/load` sends one chunk, waits about 3 s, sends another, then answers. |

The load replay gains a `user_message_chunk` before its `agent_message_chunk`.

**`tests/acp_session_reopen_test.rs`:**

- Continue with resume: `session/resume` is in the call log, no update reaches the sink, and
  `reopened_with` is resume.
- Continue with load only: `session/load`, replay dropped, `reopened_with` is load.
- Neither method offered: error.
- Import with load: user and agent chunks reach the sink for the right app session.
- With `FAKE_ACP_EARLY_REQUESTS`, the requests sent during the import are answered and the
  load completes, so there is no deadlock.
- `stop()` during a `FAKE_ACP_SLOW_REPLAY` import lets no later update through, and a new
  import of the same id works.
- Import with resume only: no update, `reopened_with` is resume.
- An existing test is adjusted only where the rename requires it.

**`tests/acp_session_list_test.rs`:**

- Three pages are followed, then the list stops.
- 11 pages of 1 session, and 3 pages of 100 sessions, both end `truncated`.
- A failure on page 2 gives `incomplete` with page 1 kept.
- A failure on page 1, no `list`, and auth-required each give the right error.
- Malformed entries are dropped: empty id, relative `cwd`, other folder, duplicate, an id
  that is too long.
- A control-character title is cleaned; a bad `updatedAt` is dropped.
- `cwd` given through a symlink the test creates is accepted. This is portable, since the
  Rust CI job runs on Ubuntu.

**Elsewhere in Rust:**

- Unit tests in `session_list.rs` for validation, title cleaning and the `cwd` comparison.
- Probe tests check `can_list_sessions` on both paths, including the sign-in-only path
  (`!needs_options && reports_auth`).

### Vitest

`setup.ts` gains canned `acp_reopen_session`, `acp_import_session` and `acp_list_sessions`.

- `acp-events.test.ts`: `applyReplayUpdate` splits turns at `user_message_chunk`, merges
  chunks of one `messageId`, and `closeTurn` ends the last turn.
- `use-agent-session-list.test.tsx` covers:
  - the state flow;
  - filtering known ids, archived ones included;
  - newest first;
  - reset on an agent or folder change;
  - an auth failure calling `requestSignIn`.
- `agent-session-list.test.tsx` covers:
  - the button hidden without `canListSessions` or with a worktree;
  - the empty, truncated, incomplete and failed states, with **Try again**;
  - keyboard focus.
- `session-import.test.tsx` covers:
  - a successful import: record made, replay folded, draft picks applied;
  - a failed import: record and transcript gone, back to the draft;
  - a double click opening the existing session;
  - a resume-only import: `historyElsewhere` set and the note shown.
- `use-acp-engine-sign-in.test.tsx`: a resume-only agent is continued after a sign-in, not
  restarted with a handoff.
- `use-agent-probe.test.tsx` and `use-draft-agent-check.test.tsx`: `canListSessions` reaches
  the draft.
- `chat-canvas.test.tsx`: the `historyElsewhere` note is shown with the flag and only then.
- `persistence.test.ts`: `historyElsewhere` is kept as a boolean and dropped otherwise.
- `relative-time.test.ts`.
- The rename is carried through `setup.ts`, `acp-app.test.tsx`, `composer-controls.test.ts`
  and `use-acp-engine-sign-in.test.tsx`.

## Docs

- `CHANGELOG.md`, under Unreleased: Zorvo continues a session with the agent's
  `session/resume` when it offers one, and you can continue a session started outside Zorvo
  (for example in the agent's CLI) from the new-session screen.
- `CLAUDE.md`:
  - in the ACP backend paragraph, reopen picks resume or load;
  - a new "Session list and import" paragraph naming `acp/session_list.rs`, the `replaying`
    map, `useAgentSessionList`, `AgentSessionList` and `applyReplayUpdate`.

## Out of scope

- `session/close` for normal sessions, `logout`, `session/delete` from the UI, MCP servers,
  `additionalDirectories`.
- `session_info_update` beyond the title Zorvo already applies, and `_meta` from
  `SessionInfo`.
- Syncing titles or existence of Zorvo sessions with the agent's list.
- Notices and compaction (the next item of the ACP audit).
