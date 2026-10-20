# ACP Terminal Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sign in to any ACP agent from inside Zorvo. Terminal methods run the agent's own login in a dialog with a PTY, then Zorvo re-checks, reconnects and sends the refused message.

**Architecture:**
- **Backend.** Zorvo advertises `auth.terminal`. A new `acp/terminal_auth.rs` reads and validates a terminal method from a fresh `initialize`, and builds the login command from the registry launch. A new command runs that command in the existing `PtySessionManager`, and `lib.rs` sends a `signin-` terminal's output on its own `sign-in-terminal` event.
- **Frontend.** `useTerminalSignIn` drives the dialog. `useAgentSignIn` coordinates both method kinds: sign in, re-check with the probe, then auto-send through the ACP engine's new `retryAfterSignIn`.

**Tech Stack:** Rust (Tauri 2, portable-pty, serde_json), React 19 + TypeScript, Vitest + Testing Library, xterm via the existing `TerminalView`.

**Spec:** `docs/superpowers/specs/2026-10-19-acp-terminal-sign-in-design.md`

Branch: `feat/acp-terminal-sign-in` off `main`, in its own worktree. Never `git add -A`: stage explicit paths.

## Global Constraints

- The webview sends only `profileId`, `cwd`, `methodId`, `terminalId`; never a program, args or env.
- `terminalId` matches `^signin-[a-z0-9-]{1,64}$` (the UI makes it with `createId("signin")`).
- Method `args`: at most 32 strings, each at most 1024 bytes, no NUL. Method `env`: string values, keys `^[A-Z_][A-Z0-9_]*$` that pass the registry deny list.
- `authenticate` is never sent for a `type: "terminal"` method.
- Zorvo advertises `clientCapabilities.auth.terminal: true`, keeps `terminal: false`, and does not advertise `_meta["terminal-auth"]`.
- No API key is collected, stored or logged; login output is never persisted.
- Every folder from the UI goes through `ensure_known_workspace`.
- Commands touching processes are `#[tauri::command(async)]`.
- Design system: tokens only (no raw colors), `focus-ring` on every control, `shadow-dialog`, `Button`/`IconButton` primitives. Copy is in sentence case, uses "you", and names the agent.
- Files under 800 lines. `src/App.tsx` (805 lines today) must not grow: the new logic lives in hooks and components.
- Commits are Conventional Commits. Green before each commit: `pnpm lint`, `pnpm test`, and from `src-tauri/` `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. Rust builds need `pnpm build` once for `dist/`.

## Review Focus

1. **The user moves to another session while the login runs.** The refused message must not be sent; the panel says to send again. (Task 8 test.)
2. **Cancel during "Starting", before the PTY exists.** Once the start returns, the PTY is terminated, and the sign-in ends as cancelled, not as running. (Task 7 test.)
3. **Exit 0, then the probe fails for an unrelated reason** (npx missing, a crash). Treated as signed in, with no "still signed out" error. (Task 8 `checkSignIn` test.)
4. **A real agent's method sets a denied variable** (`PATH`). Refused before any PTY starts, with the reason named. (Task 3 test.)
5. **The agent refuses again after the automatic retry.** The panel comes back with the message in the composer, and nothing retries in a loop. (Task 8 test.)

---

### Task 1: Advertise terminal auth and teach the fake agent a terminal login

**Files:**
- Modify: `src-tauri/src/acp/manager.rs` (`initialize`, about line 616)
- Modify: `src-tauri/src/registry/schema.rs` (`is_safe_env`, about line 259)
- Modify: `src-tauri/tests/fixtures/fake_acp_agent.mjs`
- Test: `src-tauri/tests/acp_manager_test.rs`

**Interfaces:**
- Produces: `pub(crate) fn is_safe_env_key(key: &str) -> bool` in `registry/schema.rs` (`is_safe_env` becomes `env.keys().all(|k| is_safe_env_key(k))`).
- Produces (fake agent):
  - When `params.clientCapabilities.auth.terminal === true`, `initialize` also lists `{ id: "terminal-login", name: "Sign in in a terminal", type: "terminal", args: ["--login"], env: { FAKE_LOGIN_GREETING: "hello" } }`. With `FAKE_ACP_BAD_TERMINAL_ENV` set, its `env` is `{ PATH: "/tmp" }` instead.
  - Started with `--login` (checked before the readline loop), it prints `signed in: ${FAKE_LOGIN_GREETING ?? ""}\n` and exits with `Number(process.env.FAKE_LOGIN_EXIT ?? 0)`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn offers_terminal_sign_in_because_zorvo_advertises_it() {
    let (manager, _rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_AUTH_REQUIRED", "1");

    let err = manager.start("s-1", &cwd(), &launch).unwrap_err();

    let methods = auth_methods_in(&err);
    let terminal = methods.as_array().unwrap().iter()
        .find(|m| m["id"] == "terminal-login").expect("terminal method listed");
    assert_eq!(terminal["type"], "terminal");
    assert_eq!(terminal["args"][0], "--login");
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd src-tauri && cargo test --test acp_manager_test offers_terminal_sign_in`
Expected: FAIL ("terminal method listed").

- [ ] **Step 3: Implement**

In `initialize`, `clientCapabilities` becomes `{ "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false, "auth": { "terminal": true } }`. Add the fake agent behavior and `is_safe_env_key` as in Interfaces.

- [ ] **Step 4: Run the Rust suite**

Run: `cd src-tauri && cargo test --test acp_manager_test && cargo test --test registry_schema_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/acp/manager.rs src-tauri/src/registry/schema.rs src-tauri/tests/fixtures/fake_acp_agent.mjs src-tauri/tests/acp_manager_test.rs
git commit -m "feat: advertise terminal sign-in to ACP agents"
```

### Task 2: `acp/terminal_auth.rs`, reading a terminal method and building its login

**Files:**
- Create: `src-tauri/src/acp/terminal_auth.rs` (with a `#[cfg(test)] mod tests`)
- Modify: `src-tauri/src/acp/mod.rs` (`pub mod terminal_auth;`)

**Interfaces:**
- Consumes: `is_safe_env_key` (Task 1), `AcpLaunch` (`manager.rs`), `PtyEvent` (`pty_session.rs`).
- Produces:

```rust
pub const SIGN_IN_TERMINAL_EVENT: &str = "sign-in-terminal";
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalMethod { pub args: Vec<String>, pub env: BTreeMap<String, String> }
#[derive(Debug, PartialEq, Eq)]
pub enum TerminalMethodError { NotOffered, Refused(String) }
pub fn terminal_method(init: &Value, method_id: &str) -> Result<TerminalMethod, TerminalMethodError>;
pub fn login_command(launch: &AcpLaunch, method: &TerminalMethod) -> AcpLaunch;
pub fn is_sign_in_terminal_id(id: &str) -> bool;            // ^signin-[a-z0-9-]{1,64}$
pub fn sign_in_event_payload(event: &PtyEvent) -> Value;     // see below
```

- `NotOffered`: no method with that `id`, or its `type` is not `"terminal"`.
- `Refused` messages, verbatim, each prefixed `Zorvo does not run this sign-in: `:
  - `it sets {KEY}` (a bad or denied key);
  - `it passes more than 32 arguments`;
  - `an argument is longer than 1024 bytes`;
  - `an argument contains a NUL character`;
  - `its arguments are not a list of text`;
  - `its environment is not a map of text`.
- `sign_in_event_payload`: `Output` → `{"terminalId", "kind": "output", "data"}`; `Exit` → `{"terminalId", "kind": "exit", "exitCode"}`.

- [ ] **Step 1: Write the failing tests** (in the module's tests)

- `reads_a_terminal_method`: `{"authMethods":[{"id":"t","type":"terminal","args":["--login"],"env":{"A_B":"1"}}]}` → `args == ["--login"]`, `env == {"A_B":"1"}`. Missing `args`/`env` → empty.
- `an_agent_method_or_unknown_id_is_not_offered`: `type` absent → `NotOffered`; `id` not found → `NotOffered`.
- `refuses_unsafe_methods`: 33 args; a 1025-byte arg; `"a\0b"`; `args: "x"`; `env: {"PATH":"/x"}` → `Refused("Zorvo does not run this sign-in: it sets PATH")`; `env: {"DYLD_INSERT_LIBRARIES":"x"}`; `env: {"NODE_OPTIONS":"x"}`; `env: {"lower":"x"}`; `env: {"A":1}`. Each is `Refused` with the message above.
- `login_command_appends_args_and_overrides_env`: launch `npx ["-y","pkg@1"]` env `[("A","base"),("B","keep")]` plus method args `["--cli","auth","login"]` env `{"A":"method"}` → program `npx`, args `["-y","pkg@1","--cli","auth","login"]`, env holds `A=method` once and `B=keep`.
- `sign_in_ids`: `signin-1729150000000-k3x9a` true; `session-1`, `signin-`, `signin-A`, `signin-../x` and a 65-character suffix false.
- `event_payloads`: one assertion each for output and exit.

- [ ] **Step 2: Run them to see them fail**

Run: `cd src-tauri && cargo test --lib terminal_auth`
Expected: FAIL to compile (module missing).

- [ ] **Step 3: Implement the module per Interfaces**

- [ ] **Step 4: Run them**

Run: `cd src-tauri && cargo test --lib terminal_auth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/acp/terminal_auth.rs src-tauri/src/acp/mod.rs
git commit -m "feat: read and validate ACP terminal sign-in methods"
```

### Task 3: `AcpManager::terminal_login`, and refusing terminal methods in `authenticate`

**Files:**
- Modify: `src-tauri/src/acp/manager.rs` (`authenticate`; add `terminal_login`). If `manager.rs` passes 700 lines, put `terminal_login` in `terminal_auth.rs` as `impl AcpManager`, like `probe.rs` does.
- Test: `src-tauri/tests/acp_manager_test.rs`

**Interfaces:**
- Consumes: `terminal_method`, `login_command`, `TerminalMethodError` (Task 2); `spawn_unrouted`, `initialize`, `auth_methods_of`, `auth_required_error`, `failure_message` (`manager.rs`).
- Produces: `pub fn terminal_login(&self, cwd: &str, launch: &AcpLaunch, method_id: &str) -> Result<AcpLaunch, String>`.
  - `validate_cwd`, spawn, `initialize`, kill.
  - `NotOffered` → `Err(auth_required_error(&auth_methods_of(&init)))`.
  - `Refused(m)` → `Err(m)`.
  - A failed `initialize` → the error with the stderr tail (`failure_message`).
- Produces: `authenticate` returns `Err("This sign-in runs in a terminal".into())` without sending `authenticate` when the method's `type` is `"terminal"`.

- [ ] **Step 1: Write the failing tests**

- `builds_the_login_from_the_agent_launch_and_its_terminal_method`: `terminal_login(&cwd(), &fake_agent(), "terminal-login")` → program `node`, args `[<fixture path>, "--login"]`, env contains `("FAKE_LOGIN_GREETING","hello")`.
- `asks_for_a_sign_in_again_when_the_method_is_gone`: method `"browser"` → error starts with `ACP_AUTH_REQUIRED:` and lists `terminal-login`.
- `refuses_a_terminal_method_that_sets_path`: launch with `FAKE_ACP_BAD_TERMINAL_ENV=1` → error is `Zorvo does not run this sign-in: it sets PATH`.
- `never_sends_authenticate_for_a_terminal_method`: with `FAKE_ACP_METHOD_LOG` set to a temp file, `authenticate(&cwd(), &launch, "terminal-login")` → `Err` containing `runs in a terminal`, and the log has `initialize` but not `authenticate`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd src-tauri && cargo test --test acp_manager_test terminal`
Expected: FAIL (no `terminal_login`).

- [ ] **Step 3: Implement per Interfaces**

- [ ] **Step 4: Run them**

Run: `cd src-tauri && cargo test --test acp_manager_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/acp/manager.rs src-tauri/src/acp/terminal_auth.rs src-tauri/tests/acp_manager_test.rs
git commit -m "feat: build an agent's terminal login from its own initialize"
```

### Task 4: Command `acp_start_terminal_sign_in` and the `sign-in-terminal` event

**Files:**
- Modify: `src-tauri/src/acp/commands.rs` (new command + testable helper + unit tests)
- Modify: `src-tauri/src/pty_session.rs` (add `has_session`)
- Modify: `src-tauri/src/lib.rs` (register the command; route `signin-` PTY events)
- Test: `src-tauri/tests/pty_session_test.rs`, `src-tauri/tests/acp_manager_test.rs`

**Interfaces:**
- Consumes: `terminal_login` (Task 3), `is_sign_in_terminal_id`, `sign_in_event_payload`, `SIGN_IN_TERMINAL_EVENT` (Task 2), `launch_in_workspace` (`commands.rs`).
- Produces: `pub fn has_session(&self, session_id: &str) -> bool` on `PtySessionManager`.
- Produces:

```rust
fn start_terminal_sign_in(manager: &AcpManager, pty: &PtySessionManager, store: &AppStore,
    profile_id: &str, cwd: &str, method_id: &str, terminal_id: &str) -> Result<(), String>;
#[tauri::command(async)]
pub fn acp_start_terminal_sign_in(manager: State<'_, AcpManager>, pty: State<'_, PtySessionManager>,
    store: State<'_, AppStore>, profile_id: String, cwd: String, method_id: String,
    terminal_id: String) -> Result<(), String>;
```

  Order of checks:
  1. `is_sign_in_terminal_id`, else `Err("Not a sign-in terminal id")`.
  2. `!pty.has_session`, else `Err("That sign-in is already running")`.
  3. `launch_in_workspace`.
  4. `terminal_login`.
  5. `pty.start_session(terminal_id, cwd, &login.program, &login.args, &login.env)`.
- Produces (`lib.rs`): in the `PtySessionManager` callback, an event whose session id passes `is_sign_in_terminal_id` is emitted only as `SIGN_IN_TERMINAL_EVENT` with `sign_in_event_payload`. It does not go out as `pty-output*`/`pty-exit*`.

- [ ] **Step 1: Write the failing tests**

- `pty_session_test.rs` `has_session_is_true_while_it_runs`: start `/bin/sh -c "sleep 1"`; `has_session` is true; after `kill_session` it is false.
- `acp_manager_test.rs` `runs_the_terminal_login_in_a_pty_and_reports_its_exit`:
  - `terminal_login` with the fake agent, then `PtySessionManager::start_session("signin-test-1", …)` with the result;
  - collect events: output contains `signed in: hello`, and the exit code is 0;
  - the same with `FAKE_LOGIN_EXIT=1` in the base launch env → exit code 1.
- `commands.rs` unit tests (`Scratch` pattern):
  - `a_sign_in_with_a_bad_terminal_id_is_refused`: id `"session-1"` → `"Not a sign-in terminal id"`;
  - `a_sign_in_is_not_started_in_a_folder_that_is_not_a_workspace`: valid id, unknown folder → `is not one of your workspaces`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd src-tauri && cargo test has_session && cargo test --test acp_manager_test runs_the_terminal_login && cargo test --lib sign_in`
Expected: FAIL to compile.

- [ ] **Step 3: Implement per Interfaces, register the command in `generate_handler!`, route the events in `lib.rs`**

- [ ] **Step 4: Run the full Rust gate**

Run: `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/acp/commands.rs src-tauri/src/pty_session.rs src-tauri/src/lib.rs src-tauri/tests/pty_session_test.rs src-tauri/tests/acp_manager_test.rs
git commit -m "feat: run an agent's terminal sign-in in a PTY"
```

### Task 5: Method kinds and sign-in buttons for terminal methods

**Files:**
- Modify: `src/lib/acp-auth.ts`, `src/components/AuthPanel.tsx`
- Test: `src/test/acp-auth.test.ts`, create `src/test/auth-panel.test.tsx`

**Interfaces:**
- Produces: `export type AuthMethodKind = 'agent' | 'terminal' | 'explain'`. `AuthMethod` drops `needsSecret` and gains `kind: AuthMethodKind`. The rules, in order:
  1. `type === "terminal"` → `terminal`;
  2. `_meta.type === "terminal"`, `"api-key" in _meta`, or `/api.?key/i` on the id → `explain`;
  3. otherwise → `agent`.
- Produces: `AuthPanel` shows "Sign in with {name}" for `agent` and `terminal` methods, disabled while `status === "signing-in"`. The hint "Sign in with {agent}'s own command line tool, then try again." shows when no method has a button.

- [ ] **Step 1: Write the failing tests**

- `acp-auth.test.ts`:
  - update the two `needsSecret` expectations to `kind: "explain"` / `kind: "agent"`;
  - the Qwen legacy case becomes `kind: "explain"`;
  - add `{ id: "claude-ai-login", name: "Claude Subscription", type: "terminal", args: ["--cli","auth","login","--claudeai"] }` → `kind: "terminal"`.
- `auth-panel.test.tsx`:
  - a terminal method has a "Sign in with Claude Subscription" button that calls `onSignIn("claude-ai-login")`;
  - an `explain` method has no button and shows its description;
  - with only `explain` methods the command-line hint shows;
  - with `status="signing-in"` every button is disabled.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/test/acp-auth.test.ts src/test/auth-panel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them, then the whole suite**

Run: `pnpm vitest run src/test/acp-auth.test.ts src/test/auth-panel.test.tsx && pnpm test`
Expected: PASS. The existing `acp-app.test.tsx` "API Key has no button" test still passes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/acp-auth.ts src/components/AuthPanel.tsx src/test/acp-auth.test.ts src/test/auth-panel.test.tsx
git commit -m "feat: offer an agent's terminal sign-in methods as buttons"
```

### Task 6: Retrying a refused message in a fresh agent

**Files:**
- Modify: `src/components/ComposerDock.tsx` (`ComposerHandle`)
- Modify: `src/hooks/useAcpSessions.ts` (`AcpSessionInfo.canLoad`, `toInfo`)
- Modify: `src/hooks/session-engine/useAcpEngine.ts` (`retryAfterSignIn`)
- Test: `src/test/composer-dock.test.tsx`, `src/test/use-acp-engine-sign-in.test.tsx`

**Interfaces:**
- Produces on `ComposerHandle`:
  - `holdsRestored: () => boolean`: true while the prompt text and attachments are exactly what the last `restore` left (nothing typed, sent or cleared since);
  - `clear: () => void`: empties text and attachments.
- Produces: `AcpSessionInfo.canLoad: boolean` = `agentCapabilities.loadSession === true`.
- Produces on the engine: `retryAfterSignIn: (sessionId: string, message: FirstMessage) => Promise<void>`.
  - Read the session, `info[sessionId]?.canLoad` and `takeUnsentContext(sessionId)` first.
  - If the session is not `terminated`, `await stop(sessionId)`, and return when it resolves `false`.
  - Then `resume(session, acpSessionId, { ...message, context: message.context ?? context })` when the session has an `acpSessionId` and (it was `terminated` or `canLoad`); otherwise `start(session, thatMessage)`.

- [ ] **Step 1: Write the failing tests**

- `composer-dock.test.tsx`:
  - after `restore("hi")`, `holdsRestored()` is true;
  - after typing a character it is false;
  - after `clear()` the textbox is empty and `holdsRestored()` is false.
- `use-acp-engine-sign-in.test.tsx`, with `acp_start_session` mocked to return `{ acpSessionId: "acp-1", agentCapabilities: { loadSession: true } }`:
  - `reopens a session refused at a prompt with session/load and sends the message`: `start(SESSION)`, then `retryAfterSignIn("s-1", { text: "try again" })` on a session that has `acpSessionId: "acp-1"` → in order `acp_stop_session`, `acp_load_session` (`acpSessionId: "acp-1"`), then `acp_prompt` with `"try again"`;
  - `starts a new ACP session when the agent cannot load one`: start result without `loadSession` → `acp_stop_session`, then `acp_start_session`, then the prompt;
  - `opens a session refused at start again without stopping it`: `status: "terminated"`, no `acpSessionId` → no `acp_stop_session`, then `acp_start_session` and the prompt;
  - `keeps the hidden context of a refused prompt`: the existing context case, retried → the prompt is `"EARLIER CONVERSATION\n\ntry again"`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/test/composer-dock.test.tsx src/test/use-acp-engine-sign-in.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement per Interfaces**

- [ ] **Step 4: Run them, then `pnpm lint && pnpm test`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ComposerDock.tsx src/hooks/useAcpSessions.ts src/hooks/session-engine/useAcpEngine.ts src/test/composer-dock.test.tsx src/test/use-acp-engine-sign-in.test.tsx
git commit -m "feat: reopen a session in a fresh agent after a sign-in"
```

### Task 7: The terminal sign-in dialog

**Files:**
- Create: `src/hooks/useTerminalSignIn.ts`, `src/components/TerminalSignInDialog.tsx`
- Test: create `src/test/terminal-sign-in.test.tsx`

**Interfaces:**
- Consumes: `createId` (`lib/ids.ts`), `createPtyOutputStore` (`lib/pty-output-store.ts`), `TerminalView`, `parseAuthRequired`/`AuthMethod` (Task 5); commands `acp_start_terminal_sign_in`, `send_input`, `resize_session`, `terminate_session`; event `sign-in-terminal` (Task 4).
- Produces:

```ts
export type LoginOutcome =
  | { ok: true }
  | { ok: false; reason: string; cancelled?: boolean; methods?: AuthMethod[] };
export type SignInPhase = 'starting' | 'running' | 'checking' | 'failed';
export interface TerminalSignInState { terminalId: string; agentName: string; methodName: string; phase: SignInPhase; error?: string }
export function useTerminalSignIn(): {
  dialog: TerminalSignInState | null;
  output: PtyOutputStore;
  run: (req: { profileId: string; cwd: string; agentName: string; method: AuthMethod }) => Promise<LoginOutcome>;
  showChecking: () => void;
  fail: (reason: string) => void;
  close: () => void;
  sendInput: (data: string) => void;
  resize: (cols: number, rows: number) => void;
};
```

  - The hook subscribes to `sign-in-terminal` once, on mount, and appends output to its own store.
  - On exit:
    - 0 → `{ ok: true }` (phase stays until the caller acts);
    - a cancel → `{ ok: false, reason: "Sign-in cancelled", cancelled: true }`;
    - otherwise → `{ ok: false, reason: "The sign-in ended with code N" }` and phase `failed`.
  - A start error that `parseAuthRequired` reads → `{ ok: false, reason: "{agentName} no longer offers this sign-in", methods }`; any other start error → its text. Both set phase `failed`.
  - `close()`: during `starting`/`running`/`checking`, marks the run cancelled and calls `terminate_session({ sessionId: terminalId })`. During `starting`, it does so as soon as the start resolves. It then clears the dialog and forgets the output.
- Produces: `TerminalSignInDialog` with props `{ state: TerminalSignInState; output: PtyOutputStore; onClose: () => void; onTryAgain: () => void; onInput: (d: string) => void; onResize: (c: number, r: number) => void }`.
  - Laid out like `SettingsPanel`: `role="dialog"`, `aria-modal`, labelled by the title "Sign in to {agentName}", with the method name under it.
  - `TerminalView` with `isLive` while `running`.
  - Copy by phase:
    - `Starting {agentName}…`
    - `Finish signing in in the terminal. Zorvo continues when it closes.`
    - `Checking your sign-in…`
    - failed: the error.
  - Buttons: Cancel in the first three phases; Try again and Close when failed. An X `IconButton` labelled "Cancel sign-in". Esc calls `onClose`.

- [ ] **Step 1: Write the failing tests** (mock `@tauri-apps/api/event` like `acp-app.test.tsx`, plus a helper `terminalEvent(payload)`)

- `starts the login with a sign-in terminal id and succeeds on exit 0`: `acp_start_terminal_sign_in` is called with `{ profileId, cwd, methodId, terminalId }`, the id matches `/^signin-[a-z0-9-]+$/`, the phase becomes `running`, and an exit `{ kind: "exit", exitCode: 0 }` resolves `{ ok: true }`.
- `fails with the exit code`: exit 1 → `reason: "The sign-in ended with code 1"`, phase `failed`.
- `cancelling a running login terminates it`: `close()` → `terminate_session` with that id; resolves `cancelled: true`; `dialog` null.
- `cancelling while starting terminates the login once it is up` (Review Focus 2): `close()` before the start resolves → once it resolves, `terminate_session` is called and the outcome is `cancelled`.
- `a method the agent no longer offers`: start rejects `ACP_AUTH_REQUIRED:[…]` → reason `"Qwen Code no longer offers this sign-in"` with `methods`.
- Dialog render tests: the copy for each phase; Esc calls `onClose`; failed shows "Try again" and "Close"; output events for the id reach the terminal container.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/test/terminal-sign-in.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement per Interfaces**

- [ ] **Step 4: Run them, then `pnpm lint && pnpm test`**

Expected: PASS, including `design-tokens.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useTerminalSignIn.ts src/components/TerminalSignInDialog.tsx src/test/terminal-sign-in.test.tsx
git commit -m "feat: show an agent's terminal sign-in in a dialog"
```

### Task 8: Sign-in coordination, re-check, auto-send and app wiring

**Files:**
- Create: `src/lib/sign-in-check.ts`, `src/hooks/useAgentSignIn.ts`, `src/components/SignInLayer.tsx`
- Modify: `src/hooks/useAgentAuth.ts` (state only), `src/App.tsx` (wiring, net lines ≤ 0)
- Test: create `src/test/sign-in-check.test.ts`, create `src/test/acp-sign-in.test.tsx`; modify `src/test/acp-app.test.tsx` (the test at about line 715)

**Interfaces:**
- Consumes: `useTerminalSignIn` (Task 7), `retryAfterSignIn` + `FirstMessage` (Task 6), `ComposerHandle.holdsRestored/clear` (Task 6), `AuthMethod.kind` (Task 5).
- Produces: `export async function checkSignIn(profileId: string, cwd: string): Promise<'signed-in' | 'signed-out'>`. It calls `acp_probe_agent` with `{ profileId, cwd, needsOptions: false }`:
  - resolves → `signed-in`;
  - rejects with a `parseAuthRequired` match → `signed-out`;
  - any other rejection → `signed-in`.
- Produces: `AuthRequest.pending?: FirstMessage & { sessionId: string }`; `requestSignIn(profileId, cwd, methods, pending?)`. `AgentAuth` keeps `{ authRequest, requestSignIn, signIn, dismiss }` for `useDraftAgentCheck`.
- Produces:

```ts
export interface AgentSignInDeps {
  agents: AgentProfile[];
  composerRef: RefObject<ComposerHandle | null>;
  activeSessionIdRef: { readonly current: string | undefined };
  retryAfterSignIn: (sessionId: string, message: FirstMessage) => void;
}
export function useAgentSignIn(deps: AgentSignInDeps): {
  auth: AgentAuth;
  /** The agent refused: puts the message back in its session's composer (when active) and opens the panel. */
  handBack: (session: Pick<Session, 'id' | 'profileId' | 'cwd'>, methods: AuthMethod[], unsent?: FirstMessage) => void;
  terminal: ReturnType<typeof useTerminalSignIn>;
};
```

  `handBack` records `pending` only when it restored the message. `auth.signIn(methodId)`:
  1. Find the method; return for an unknown method or one of kind `explain`. Set status `signing-in`.
  2. Kind `agent`: `acp_authenticate`. Kind `terminal`: `terminal.run(...)`. On failure, a cancel resets the status to `idle`; any other failure sets `failed` with the reason, and replaces the methods when the outcome carries them.
  3. For a terminal method, `terminal.showChecking()`. Then `checkSignIn`. When it says `signed-out`, the reason is `"{agent} still says you are signed out"`: `terminal.fail(reason)` (terminal) and status `failed`.
  4. On success, `terminal.close()`. Then, if `pending` exists, `activeSessionIdRef.current === pending.sessionId` and `composerRef.current?.holdsRestored()`, call `composerRef.current.clear()`, `dismiss()` and `retryAfterSignIn(pending.sessionId, { text, attachments })`. Otherwise set status `signed-in`, which keeps today's "Signed in to {agent}. Send your message again." and today's draft re-probe.
- Produces: `SignInLayer({ signIn, agents })` renders `AuthPanel` when `auth.authRequest` is set, and `TerminalSignInDialog` when `terminal.dialog` is set (`onTryAgain` calls `auth.signIn` with the same method).
- `App.tsx`:
  - replace `useAgentAuth()` with `useAgentSignIn({ agents, composerRef, activeSessionIdRef, retryAfterSignIn: (id, m) => void acp.retryAfterSignIn(id, m) })`, and move `activeSessionIdRef` above it;
  - pass `signIn.auth` to `useDraftAgentCheck`;
  - `onAuthRequired: signIn.handBack`;
  - replace the `AuthPanel` block with `<SignInLayer … />`.

- [ ] **Step 1: Write the failing tests**

- `sign-in-check.test.ts`: resolves → `signed-in`; `ACP_AUTH_REQUIRED:[]` → `signed-out`; `"npx not found"` → `signed-in` (Review Focus 3).
- `acp-sign-in.test.tsx` (helpers copied from `acp-app.test.tsx`: the `listen` mock, `renderWithQwen`, `send`, `callsTo`; plus `terminalEvent`). The methods are `[{ id: "claude-ai-login", name: "Claude Subscription", type: "terminal" }]`, and the first `acp_start_session` is refused with them:
  - `signs in through the agent's terminal login and sends the refused message`: click "Sign in with Claude Subscription" → dialog "Sign in to Qwen Code"; an exit 0 for the `terminalId` in the call, with `acp_probe_agent` resolving → `acp_start_session` called twice, `acp_prompt` text `"hello"`, composer empty, dialog and panel gone.
  - `keeps the dialog open with the reason when the login fails`: exit 1 → "The sign-in ended with code 1", a "Try again" button; nothing sent.
  - `says the agent still is signed out`: probe rejects `ACP_AUTH_REQUIRED:[]` → "Qwen Code still says you are signed out"; nothing sent.
  - `cancelling stops the login and leaves the message`: Cancel → `terminate_session` with the id; dialog gone; panel buttons enabled; composer still `"hello"`.
  - `does not send a message the user changed`: after the refusal, type into the composer; sign in → "Signed in to Qwen Code. Send your message again."; `acp_start_session` called once.
  - `does not send into another session` (Review Focus 1): after the refusal, click "+ New session"; sign in → no second `acp_start_session`; the panel says to send again.
  - `an agent sign-in sends the refused message too`: method `{ id: "chat-gpt", name: "ChatGPT" }`, with `acp_authenticate` and the probe resolving → `acp_start_session` twice and `acp_prompt` `"hello"`.
  - `a second refusal opens the panel again without retrying` (Review Focus 5): `acp_start_session` always refuses → after one sign-in, exactly two `acp_start_session` calls, the panel is back, and the composer holds `"hello"`.
- `acp-app.test.tsx` about line 715: after the agent sign-in (`acp_probe_agent` mocked to resolve), expect a second `acp_start_session` call instead of the "Signed in to Qwen Code" text.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/test/sign-in-check.test.ts src/test/acp-sign-in.test.tsx src/test/acp-app.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement per Interfaces and wire `App.tsx`**

- [ ] **Step 4: Run the gate**

Run: `pnpm lint && pnpm test && wc -l src/App.tsx`
Expected: PASS; `App.tsx` at most 805 lines.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sign-in-check.ts src/hooks/useAgentSignIn.ts src/hooks/useAgentAuth.ts src/components/SignInLayer.tsx src/App.tsx src/test/sign-in-check.test.ts src/test/acp-sign-in.test.tsx src/test/acp-app.test.tsx
git commit -m "feat: sign in, check and send the refused message again"
```

### Task 9: Docs and the final check

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]` → `### Added`), `CLAUDE.md` (Architecture)

- [ ] **Step 1: Write the docs**

- CHANGELOG line: **Sign in from Zorvo.** Agents that sign in through their own login, such as Claude Agent's Claude subscription or Anthropic Console, now offer it in the sign-in panel. The login runs in a terminal inside Zorvo, and your message is sent once you are signed in. Zorvo never sees or stores your keys.
- `CLAUDE.md`, after the "Probing a draft's agent" paragraph: **Terminal sign-in.** Zorvo advertises `auth.terminal`. `acp_start_terminal_sign_in` reads a `type: "terminal"` method from a fresh `initialize` (`acp/terminal_auth.rs`, same env deny list as the registry) and runs the agent's own program plus the method's args in a PTY with a `signin-` id. Its output goes on `sign-in-terminal`, not `pty-output`. `useAgentSignIn` re-checks with the probe and sends the refused message through `retryAfterSignIn`. `authenticate` is never sent for a terminal method.

- [ ] **Step 2: Run the full gate**

Run: `pnpm lint && pnpm test && (cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)`
Expected: PASS.

- [ ] **Step 3: Manual check in `pnpm tauri dev`**

With Claude Agent signed out (`claude auth logout`): start a session, send "hello", click "Sign in with Claude Subscription", finish in the browser. Expected: the dialog closes and "hello" is sent, without Terminal.app.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: describe terminal sign-in"
```
