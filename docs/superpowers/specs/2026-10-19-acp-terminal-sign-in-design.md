# ACP terminal sign-in — design

Date: 2026-10-19
Branch: `docs/acp-terminal-sign-in-spec` (spec), implementation on `feat/acp-terminal-sign-in`
Sub-project 3 of 5 in "every ACP agent, set up inside Zorvo"

## Goal

A user can sign in to any ACP agent from inside Zorvo, without opening
Terminal.app. Agents that sign in through their own interactive login
(Claude Agent's `claude auth login`, an API-key prompt, a device code) run
that login in a terminal inside Zorvo. Once it finishes, Zorvo checks the
sign-in, reconnects, and sends the message the agent refused.

Today Zorvo advertises no terminal auth, so Claude Agent offers no sign-in
method at all and the panel tells the user to use the command line.

### The five sub-projects

1. **Registry and catalog**: merged in PR #48.
2. **Installer**: Zorvo's own Node.js and `uv`, verified binary downloads.
3. **Terminal sign-in** (this document).
4. **Catalog UI**: an Agents page with Add, Install and Update.
5. **Clean-up**: remove Oh-My-Pi, Aider and the terminal-session engine.
   The PTY pieces this sub-project uses stay (see *Kept for this
   sub-project*).

## Decisions already made

| Topic | Decision |
|---|---|
| API keys | Zorvo never collects, stores or passes API keys, and uses no Keychain. An agent asks for its key in its own terminal login and stores it itself. |
| `env_var` auth | Not supported: ACP removed it in July 2026 in favour of `agent` and `terminal` methods. |
| Existing setups | Keep working: agents read their own config (for example `~/.qwen`), and Zorvo passes the user's login-shell environment. |
| Capability | Zorvo advertises the standard `clientCapabilities.auth.terminal: true`, not the older `_meta["terminal-auth"]`, whose descriptor names a `command`. |
| Where the login runs | A modal dialog with a terminal. |
| Closing the dialog | Closing it (X, Esc or Cancel) while the login runs stops the login. |
| After a successful login | Zorvo re-checks the sign-in, reconnects, and sends the refused message by itself. |
| Exit 0 but still signed out | When the agent can tell, the re-check wins: the sign-in failed. |
| Reading the method | The backend asks the agent for the method's `args` and `env` right before the login (a short `initialize`); nothing is cached. |
| `agent` methods | Use the same after-sign-in step (re-check, reconnect, send). |

## Constraints

- The webview never chooses what runs. It sends `profileId`, `cwd`,
  `methodId` and a `terminalId`; the backend resolves the program from the
  registry profile and reads `args`/`env` from the agent itself.
- An auth method descriptor cannot name a program, only `args` and `env`.
- Every folder from the UI is checked with `ensure_known_workspace`.
- `authenticate` is never sent for a `terminal` method.
- No secrets are asked for or stored. Terminal output is never persisted.
- Test-first; `pnpm lint`, `pnpm test`, `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings` and `cargo test` green.
- Source files stay under 800 lines; `App.tsx` does not grow beyond wiring.

## The ACP rules this follows

From the ACP v1 authentication docs and the auth-methods RFD:

- A client advertises `clientCapabilities.auth.terminal: true` only if it
  can reproduce the agent's invocation in an interactive terminal. An agent
  may list `terminal` methods only then.
- A `terminal` method has `id`, `name`, optional `description`,
  `type: "terminal"`, optional `args` (default `[]`) and optional `env` (a
  map in v1, default empty).
- The client runs the same configured agent program and base launch
  configuration as the ACP connection, appends the method's `args`, and
  applies its `env` over same-named base variables.
- It shows the terminal and waits for the process to exit. Exit 0 is
  success; a non-zero status, termination without a status, or
  cancellation is failure. There is no in-band success signal.
- On success the client reconnects, reinitializes the agent and retries the
  operation that needed the sign-in.
- The client must not send `authenticate` with a terminal method's id.

Claude Agent 0.85.1, for example, lists `claude-ai-login`
(`args: ["--cli", "auth", "login", "--claudeai"]`) and `console-login`
(`args: ["--cli", "auth", "login", "--console"]`) when
`auth.terminal === true`, so Zorvo runs
`npx -y @agentclientprotocol/claude-agent-acp@<version> --cli auth login --claudeai`.

## Backend

### Advertising the capability

`initialize()` in `acp/manager.rs` sends:

```json
"clientCapabilities": {
  "fs": { "readTextFile": false, "writeTextFile": false },
  "terminal": false,
  "auth": { "terminal": true }
}
```

`terminal: false` is a different capability (the agent running commands in
client terminals) and stays false. Sessions, probes and `authenticate` all
use this `initialize`, so every agent sees the same capabilities.

### `acp/terminal_auth.rs` (new)

- `TerminalMethod { args: Vec<String>, env: BTreeMap<String, String> }`.
- `terminal_method(init: &Value, method_id: &str) -> Result<TerminalMethod, String>`
  finds the entry of `init["authMethods"]` whose `id` is `method_id` and
  whose `type` is `"terminal"`, and validates it:
  - `args`: absent, or an array of at most 32 strings, each at most 1024
    bytes and free of NUL;
  - `env`: absent, or an object of string values whose keys match
    `^[A-Z_][A-Z0-9_]*$` and pass the registry's env deny list (`DYLD_`,
    `LD_`, `NPM_CONFIG_`, `UV_`, `PIP_`, `PYTHON`, `NODE_` prefixes;
    `PATH`, `HOME`, the proxy and CA variables, `BASH_ENV`, `ENV`,
    `SHELL`). The deny list in `registry/schema.rs` becomes `pub(crate)`
    and is shared, not copied.

  A method that breaks a rule is refused whole, with a message naming the
  reason (for example "Zorvo does not run this sign-in: it sets PATH").
  Nothing is dropped silently.
- `login_command(launch: &AcpLaunch, method: &TerminalMethod) -> AcpLaunch`:
  same `program`; `args` are `launch.args` followed by `method.args`; `env`
  is `launch.env` (login-shell env plus registry env) with `method.env`
  applied over it. Arguments go to the process as a vector, never through
  a shell.
- `AcpManager::terminal_login(cwd, launch, method_id) -> Result<AcpLaunch, String>`
  spawns the agent with `spawn_unrouted`, sends `initialize`, kills it, and
  returns `login_command(launch, &terminal_method(&init, method_id)?)`.
  When the method is missing or not `type: "terminal"`, the error is
  `auth_required_error` with the methods just reported, so the panel can
  show what the agent offers now.
  A failed `initialize` reports the agent's stderr tail, as opening a
  session does.

### Command `acp_start_terminal_sign_in` (new)

```rust
#[tauri::command(async)]
pub fn acp_start_terminal_sign_in(
    manager: State<'_, AcpManager>,
    pty: State<'_, PtySessionManager>,
    store: State<'_, AppStore>,
    profile_id: String,
    cwd: String,
    method_id: String,
    terminal_id: String,
) -> Result<(), String>
```

1. Checks `terminal_id` matches `^signin-[a-z0-9-]{1,64}$` and is not a
   running PTY.
2. `launch_in_workspace(&store, &cwd, &profile_id)`: the folder check and
   the same registry resolution as a session (and, once sub-project 2
   lands, the same installed program).
3. `manager.terminal_login(&cwd, &launch, &method_id)`.
4. `pty.start_session(&terminal_id, &cwd, &login.program, &login.args, &login.env)`.
5. Returns once the PTY runs.

Output and exit of a `signin-` terminal go out on their own event,
`sign-in-terminal` (`{ terminalId, kind: "output", data }` or
`{ terminalId, kind: "exit", exitCode }`), instead of `pty-output` and
`pty-exit`. The PTY engine turns every `pty-output` into chat messages of a
session, so a login's output must not reach it; a separate channel also lets
sub-project 5 remove that engine without touching the sign-in.

It is registered in `lib.rs`'s `generate_handler!`.

### `acp_authenticate`

`AcpManager::authenticate` reads the methods from its own `initialize` and
refuses a `methodId` whose `type` is `"terminal"` before sending
`authenticate`, so a confused UI can never pass a terminal method to the
agent.

### Kept for this sub-project

The sign-in uses these PTY pieces unchanged; sub-project 5 must keep them:
`PtySessionManager`, the `send_input`, `resize_session` and
`terminate_session` commands, `PtyOutputStore` and `TerminalView`. `end_orphaned_sessions`
(`kill_all`) already ends a sign-in terminal left behind by a webview reload
or by quitting.

## Frontend

### Method kinds (`lib/acp-auth.ts`)

`AuthMethod.needsSecret` becomes `kind`:

| Kind | When | Panel |
|---|---|---|
| `agent` | Any other method (no `type`, or `type: "agent"`) | Button; runs `acp_authenticate` |
| `terminal` | `type === "terminal"` | Button; opens the sign-in dialog |
| `explain` | An API-key method (`_meta["api-key"]`, an id like `api-key`), or the older `_meta.type === "terminal"` without the standard `type` | Name and description only |

### `AuthPanel`

Each `agent` or `terminal` method gets a "Sign in with {name}" button.
While a sign-in runs (either kind), the buttons are disabled: one sign-in
at a time. An `explain` method keeps today's text, and the "use the command
line" hint shows only when no method has a button.

### `TerminalSignInDialog` (new)

A modal dialog (`role="dialog"`, `aria-modal`, focus trapped, design tokens,
`shadow-dialog`, `focus-ring` on every control), titled
"Sign in to {agent}", with the method name under the title and a
`TerminalView` fed by a `PtyOutputStore` of its own for the `terminalId`.

| State | Shown | Controls |
|---|---|---|
| Starting | "Starting {agent}…" (the short `initialize`) | Cancel |
| Running | "Finish signing in in the terminal. Zorvo continues when it closes." | Cancel |
| Checking | "Checking your sign-in…" | Cancel (stops waiting; the login already ended) |
| Failed | The reason, with the terminal output left on screen | Try again, Close |
| Signed in | The dialog closes by itself | — |

X, Esc and Cancel while the login runs call `terminate_session`; the
sign-in ends as "Sign-in cancelled". Failure reasons: "The sign-in ended
with code N", "Sign-in cancelled", "{agent} still says you are signed
out", or the error of `acp_start_terminal_sign_in`.

### `useTerminalSignIn` (new hook)

Drives one terminal sign-in: makes `signin-<uuid>`, calls
`acp_start_terminal_sign_in`, follows the `sign-in-terminal` events of
that id, and
resolves to success, failure or cancellation. It owns the dialog state, so
`App.tsx` only renders the dialog.

### The re-check

After exit 0 (terminal) or a successful `authenticate` (agent), the hook
calls `acp_probe_agent` with `needsOptions: false`:

- a sign-in error: failed, "{agent} still says you are signed out";
- success: signed in. An agent that cannot report its sign-in either opens
  a session (signed in) or refuses it (the case above); one that reports it
  but stays silent is trusted on its exit code;
- any other error: signed in on the strength of exit 0; a later refusal
  opens the panel again.

The draft check (`useDraftAgentCheck`) keeps re-probing on `signed-in` as
today, so a draft learns the agent's options after the sign-in.

### After the sign-in (`useSignInRetry`, new hook)

When an agent refuses, `onAuthRequired` records, next to the methods,
`pending = { sessionId, text, attachments }`, but only when that message
was put back into the composer of that session. After a successful
sign-in of either kind:

1. If `pending` exists, its session is the active one, and the composer
   still holds exactly that text and those attachments (new composer
   handle methods `peek()` and `clear()`), the composer is cleared and the
   ACP engine's new `retryAfterSignIn(sessionId, message)` runs:
   - **refused at start** (the session is `terminated`): open the session
     again with the message (start, or resume when it has an
     `acpSessionId`);
   - **refused at a prompt** (the session runs on an agent process that is
     still signed out, as Claude Agent does): stop that session's
     connection and open it again with `session/load` when the agent
     supports it, otherwise with a new ACP session in the same app
     session, then send the message. This is the reconnect and
     reinitialize ACP asks for. Other sessions on the old process are
     handled the same way if they are refused later.
2. Otherwise the panel says "Signed in to {agent}. Send your message
   again." and nothing is sent.
3. With no session (a draft), only the re-check runs; the panel closes.

`authenticate` runs in its own short-lived process, so a session refused at
a prompt needs this reconnect after an `agent` sign-in too; today's "send
again" in the same session could be refused again.

### Windows

The panel and the dialog live in the main window only, as the panel does
today. Popouts do not show them.

## Error handling

| Case | Behavior |
|---|---|
| Folder is not a workspace | Refused by `ensure_known_workspace`; failed state shows the error |
| Agent is not `ready` | The message `launch_for` gives ("… is not installed") |
| The agent no longer lists the method, or it is not `type: "terminal"` | The command fails with `ACP_AUTH_REQUIRED:` and the methods `initialize` just reported; the dialog says "{agent} no longer offers this sign-in" and the panel shows those methods |
| `args` or `env` break a rule | Refused whole; the message names the reason |
| `initialize` fails or times out | The error with the agent's stderr tail |
| Exit code not 0, a signal, or Cancel | Failed; the output stays; Try again |
| Exit 0 but the re-check says signed out | "{agent} still says you are signed out" |
| The login never ends | No timeout; the user cancels |
| Webview reload or quit | `kill_all` ends the sign-in terminal |
| Retry after sign-in fails | Reported like any failed start or prompt; a new refusal opens the panel again |

## Security

- The program is always `launch.program` from the registry profile, with
  the profile's base arguments first. The agent only adds `args` and
  `env`, under the same rules as registry env, and never through a shell.
- Zorvo does not advertise `_meta["terminal-auth"]`, whose descriptors name
  a command.
- The login runs in a known workspace, with the same environment the agent
  gets for a session.
- Keys typed into the login go to the agent's program, which stores them;
  Zorvo never reads, stores or logs them. PTY output lives only in memory
  (`PtyOutputStore`) and is dropped when the dialog closes.

## Testing

Rust, unit:

- `terminal_method`: found; not `type: "terminal"`; missing id; more than
  32 args; an arg over 1024 bytes; a NUL; a lower-case env key; a denied
  key (`PATH`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`); non-string values.
- `login_command`: method args follow the base args; method env overrides
  a base variable of the same name; the program is unchanged.
- `terminalId` validation.
- `initialize` sends `auth.terminal: true` and `terminal: false`.
- `authenticate` refuses a terminal method without sending `authenticate`.

Rust, integration (`fake_acp_agent.mjs` gains a terminal method and a
`--login` mode that prints a line and exits 0 or 1):

- `acp_start_terminal_sign_in` runs the fake agent's program with its base
  args plus the method's args, in the PTY, and its exit code arrives.
- A folder that is not a workspace is refused before anything spawns.

Frontend:

- `parseAuthRequired` gives each method its `kind`.
- `AuthPanel` shows buttons for `agent` and `terminal` methods only, and
  disables them while a sign-in runs.
- The dialog goes Starting → Running → Checking → closed on success; a
  non-zero exit, a cancel (`terminate_session` called) and "still signed
  out" each end in Failed with Try again.
- After a sign-in, the refused message is sent only when the composer still
  holds it unchanged; otherwise the panel asks to send again.
- A session refused at a prompt is stopped and reopened before the message
  is sent; one refused at start is opened again.
- An `agent` sign-in goes through the same re-check and retry.

Manual, in a debug build: with Claude Agent signed out, start a session,
send a message, click "Sign in with Claude Subscription", finish in the
browser, and see the message sent without opening Terminal.app.

## Out of scope

- A sign-out button (`logout`).
- `env_var` methods, or any field for API keys.
- The sign-in dialog in popout windows.
- ACP elicitation.
- The catalog page and installer (sub-projects 2 and 4).
