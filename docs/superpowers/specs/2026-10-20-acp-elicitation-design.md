# ACP elicitation — design

Date: 2026-10-20
Branch: `feat/acp-elicitation`, rebased onto `main` once the request-routing
fix (`fix/acp-answer-every-request`) is merged. No code is written before then.

## Goal

An ACP agent can ask the user for structured input in the chat (form mode),
or ask to send them to a web page such as an OAuth sign-in (URL mode). Today
Zorvo answers every `elicitation/create` with `-32601`, so agents fall back
to plain text or fail.

## Decisions

| Topic | Decision |
|---|---|
| Field types | Every type the spec defines: string (formats `email`, `uri`, `date`, `date-time`), number, integer, boolean, single select (`enum`, `oneOf`), multi-select (`items.enum`, `items.anyOf`). A form with an unknown property type is shown, but can only be declined or dismissed. |
| Validation | In the UI for quick feedback, and again in Rust on submit against the backend's own copy of the schema. `pattern` is only checked in Rust, with the `regex` crate (linear time, size-limited). |
| Where it shows | An inline card in the chat, attached to the agent's current reply, styled like the permission card. |
| URL consent | The card is the consent: it shows the full URL with the host emphasised, and **Open in browser** opens it at once. Suspicious URLs get a warning on the card, still one click. |
| URL schemes | `https` anywhere; `http` only to a loopback host (`localhost`, `127.0.0.1`, `[::1]`). Anything else is shown as blocked and can only be declined or dismissed. |
| Opening a URL | macOS `open` from the backend (the same path as `open_external_url`), never a webview navigation. The URL opened is the backend's copy; the UI only names the request. |
| Before the session is registered | During `start`/`load` (a new connection hosting one session), the card appears in the session being opened. Elsewhere (fork on a shared connection, probe, `authenticate`) the request is answered `cancel`. |
| Cancellation | **Stop** answers every open elicitation of the session with `cancel` before `session/cancel`. A finished turn does not close cards (elicitation is not tied to turns). Agent exit, session stop, failed start and app reload leave cards unanswered. |
| Architecture | The backend owns pending requests (approach 1): Rust parses, stores, validates and opens. The UI renders a view and sends back a Zorvo-made key, an action and, for a form, the content. |

## Constraints

- **Privacy.** What the user types into a form goes from the card's local
  React state to the `acp_respond_elicitation` command to the agent's stdin.
  It is never stored in the transcript, `state.json`, a backend struct, an
  event or a log. Validation messages describe the rule, never the value.
- **Network.** The webview makes no network requests; the CSP is unchanged.
  The backend makes none either: it only hands the URL to macOS `open`.
- **Trust boundary.** The webview never sends a URL, a schema or a JSON-RPC
  id. It sends the app session id, a key Zorvo made, an action and content.
- **Design system.** Tokens only, `ui/` primitives, `focus-ring` on every
  control, sentence-case copy that names the agent.
- Source files stay under 800 lines; `manager.rs` (704 lines) and `App.tsx`
  only gain wiring.
- Test-first; `pnpm lint`, `pnpm test`, `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings` and `cargo test` green.

## The ACP rules this follows

From `protocol/v1/elicitation`, the elicitation RFD (completed 2026-07-22)
and the v1 schema:

- `clientCapabilities.elicitation` advertises each mode explicitly:
  `{ "form": {}, "url": {} }`. `{}` advertises none (unlike MCP).
- `elicitation/create` carries `mode` (`"form"` or `"url"`), `message`, and
  either `requestedSchema` (form) or `elicitationId` + `url` (url). Scope is
  flattened: `sessionId` (optionally `toolCallId`) or `requestId`, the id of a
  client request the agent is handling (for example `session/new`).
- A request for a mode the client did not advertise is answered with
  JSON-RPC `-32602`.
- The answer is `{ action: "accept", content? } | { action: "decline" } |
  { action: "cancel" }`. `cancel` means dismissed without choosing.
- URL `accept` means the user consented to open the URL, not that the
  interaction finished. The agent may later send the notification
  `elicitation/complete { elicitationId }`; the client must ignore unknown or
  already-completed ids.
- Readers tolerate a missing or malformed schema `type` (treated as
  `"object"`) and missing `properties` (empty). Unknown property types are
  never rendered as a known control. Unknown string formats are annotations.
- Clients must show the full URL before consent, never prefetch, open it in a
  context the client cannot inspect, and should warn about suspicious hosts
  (Punycode). URLs in form fields are not made clickable.
- Clients should pre-fill defaults and validate before sending; a `pattern`
  must be evaluated with bounded time and memory.

## Backend (Rust)

### Capability

`manager::initialize()` adds `"elicitation": { "form": {}, "url": {} }` to
`clientCapabilities`. Probes and `authenticate` share that function; their
requests are answered `cancel` (see Routing).

### `acp/elicitation/` module

Pure functions with no connection or Tauri dependency, split so each file
stays small:

- `mod.rs`: `parse_request(params: &Value) -> Result<Elicitation, String>`.
  An unknown `mode`, a form whose `requestedSchema` is not an object, or a URL
  request without a string `url` and `elicitationId` is an error, answered
  `-32602` with the message.

  ```rust
  pub enum Elicitation {
      Form { message: String, fields: Vec<Field> },
      Url { message: String, elicitation_id: String, url: String, check: UrlCheck },
  }
  pub struct Field {
      pub name: String,          // the property key
      pub title: Option<String>,
      pub description: Option<String>,
      pub required: bool,
      pub kind: FieldKind,
      pub default: Option<Value>, // only when it fits the kind
  }
  pub enum FieldKind {
      Text { format: Option<String>, min_length: Option<u64>, max_length: Option<u64>, pattern: Option<String> },
      Number { integer: bool, minimum: Option<f64>, maximum: Option<f64> },
      Boolean,
      Select { options: Vec<Choice> },                       // enum or oneOf
      MultiSelect { options: Vec<Choice>, min_items: Option<u64>, max_items: Option<u64> },
      Unsupported { raw_type: String },
  }
  pub struct Choice { pub value: String, pub title: String, pub description: Option<String> }
  ```

  Field order follows `properties`. A `type: "array"` whose items are neither
  a string `enum` nor an `anyOf` of `const`s, and any unknown `type`, is
  `Unsupported`.
- `url_check.rs`: `check_url(url: &str) -> UrlCheck { host, blocked: Option<String>, warnings: Vec<UrlWarning> }`,
  using the `url` crate. Blocked: not parseable, a scheme other than
  `https`, or `http` to a host that is not loopback. Warnings: a Punycode
  label (`xn--`), an IP-address host, or user info (`user@`) in the URL.
- `validate.rs`: `validate(fields: &[Field], content: &Value) -> Result<Value, FieldErrors>`
  returns the content to send: only known properties, each checked for type,
  required, length, minimum/maximum, integer-ness, options (single and
  multi), item counts, and the known formats (`email`: one `@` with text on
  both sides and a dot in the domain; `uri`: parses with a scheme; `date`:
  `YYYY-MM-DD`; `date-time`: RFC 3339). `pattern` is compiled with
  `regex::RegexBuilder` and a size limit; a pattern that does not compile or
  exceeds the limit is treated as an annotation (the agent validates again).
  A form with an `Unsupported` field cannot be accepted. `FieldErrors` maps a
  field name to a message such as "Use at most 50 characters"; no message
  contains the value.
- `pending.rs`: the store of open requests.

  ```rust
  struct Pending {
      app_session_id: String,
      connection: Arc<AcpConnection>,
      connection_key: u64,
      request_id: Value,              // JSON-RPC id, never sent to the UI
      elicitation: Elicitation,
      state: PendingState,            // Open | AwaitingCompletion (url, after accept)
  }
  ```

  Keyed by a Zorvo-made key `el-<n>`. Lookups: by key; by
  `(connection_key, elicitation_id)` for completion; all keys of an app
  session for cancel and stop. A URL request moves to `AwaitingCompletion`
  after `accept` and is dropped on `elicitation/complete`, on stop, or on
  agent exit.

### Routing (`manager.rs`)

Built on the routing fix, where the connection sink can answer every request
because it holds a `Weak<AcpConnection>` from the start.

`elicitation/create` goes to `route_elicitation`:

1. Parse. On an error, answer `-32602`.
2. Find the app session:
   - `sessionId` registered in `by_acp_id`: that session.
   - Otherwise (`sessionId` unknown yet, or `requestId`), if the connection
     is in `opening` (a new map `connection_key -> app_session_id`, filled by
     `open()` for `start`/`load` and cleared when `open()` returns): that
     session.
   - Otherwise: answer `{ "action": "cancel" }` and stop.
3. Store it as `Pending` and emit `AcpEvent::Elicitation { session_id, key, view }`.

`elicitation/complete` (a notification) looks up
`(connection_key, elicitationId)` in `AwaitingCompletion`. When it is found,
the request is dropped and `AcpEvent::ElicitationComplete { session_id, key }`
is emitted. Anything else is ignored.

`spawn_unrouted` (probes, `authenticate`) answers `elicitation/create` with
`{ "action": "cancel" }` instead of `-32601`, so the agent sees a dismissal
and not an unsupported method we advertised.

### Commands (`acp/commands.rs`, registered in `lib.rs`)

- `acp_respond_elicitation(session_id, key, action, content: Option<Value>)`
  - `action` must be `accept`, `decline` or `cancel`.
  - The key must belong to `session_id` and be `Open`; otherwise
    `Err("This request can no longer be answered.")`.
  - Form `accept`: `validate`. On failure,
    `Err("ELICITATION_INVALID:" + json(FieldErrors))` and the request stays
    open. On success, answer `{ action: "accept", content }`.
  - URL `accept`: if `blocked`, refuse. Open the backend's URL with
    `windows::open_url`. If that fails, return the error and do not answer.
    On success, answer `{ action: "accept" }` and move to `AwaitingCompletion`.
  - `decline` / `cancel`: answer `{ action }` and drop.
- `acp_reopen_elicitation_url(session_id, key)` opens the URL of a request in
  `AwaitingCompletion` again (the user closed the tab). It sends nothing to
  the agent.

Both are `#[tauri::command(async)]`, because they spawn `open`.

### Cancellation and teardown

- `AcpManager::cancel` answers each `Open` request of the session with
  `{ action: "cancel" }`, then sends `session/cancel`.
- `stop`, `ConnectionEvent::Exited`, and an `open()` that fails or times out
  drop the session's pending requests (nothing is left to answer).
  `HANDSHAKE_TIMEOUT` (180 s) still bounds a start that waits on a form.

### Event payloads (`acp-event`)

```jsonc
{ "sessionId": "s-1", "kind": "elicitation", "key": "el-3",
  "request": { "mode": "form", "message": "…", "fields": [
    { "name": "strategy", "title": "Strategy", "description": null, "required": true,
      "kind": { "type": "select", "options": [{ "value": "balanced", "title": "balanced", "description": null }] },
      "default": "balanced" } ] } }

{ "sessionId": "s-1", "kind": "elicitation", "key": "el-4",
  "request": { "mode": "url", "message": "…", "url": "https://…", "host": "agent.example.com",
               "warnings": ["punycode"], "blocked": null } }

{ "sessionId": "s-1", "kind": "elicitation-complete", "key": "el-4" }
```

## Frontend

### Types (`src/types/index.ts`)

`ChatMessage` gains `elicitation?: ElicitationCard`, separate from
`actionCard`, so a permission request and a question can sit in the same turn.

```ts
export interface ElicitationCard {
  key: string;
  sessionId: string;
  mode: 'form' | 'url';
  message: string;
  status: 'pending' | 'submitted' | 'declined' | 'dismissed' | 'opened' | 'completed' | 'unanswered';
  timestamp: number;
  /** Form mode while pending. */
  fields?: ElicitationField[];
  /** URL mode: the full URL only while pending; the host stays (Open again goes by key). */
  url?: string;
  host?: string;
  warnings?: ('punycode' | 'ip-address' | 'user-info')[];
  blocked?: string;
  /** Why the last submit was refused, by field name. Rules only, never values. */
  errors?: Record<string, string>;
}
```

Values the user types are not part of any type that reaches the transcript.

### Folding (`src/lib/acp-elicitation.ts`)

Kept out of `acp-events.ts`, which only gains a dispatch line.

- `applyElicitation(messages, payload, ctx)` attaches the card to the open
  agent reply, or starts a new agent message when there is none or it
  already has an elicitation.
- `resolveElicitation(messages, key, status)` and
  `completeElicitation(messages, key)` set the status. Once a card is not
  `pending`, `fields`, `url` and `errors` are removed, so a saved transcript
  holds only the summary and the host.
- `rejectElicitationSubmit(messages, key, errors)` sets the card back to
  `pending` with `errors`.
- `markElicitationsUnanswered(messages)` and `dismissPendingElicitations(messages)`.
- `isAwaitingUser(messages)` replaces `isAwaitingPermission`: a pending
  permission card **or** a pending elicitation. It feeds the sidebar badge,
  the background-task "needs approval" state, `isWorking`, and the
  attention notification (`notifyAttention`).

### Components (`src/components/chat/`)

- `ElicitationCard.tsx`: the attention-styled card.
  - Titles: "<Agent> asks for input" (form), "<Agent> wants to open a page" (URL).
  - The agent's `message`, titles and descriptions render as plain text; nothing in them is a link.
  - Form buttons: **Submit** (primary), **Decline**, **Dismiss** (sends `cancel`).
  - URL buttons: **Open in browser** (primary), **Decline**, **Dismiss**. The full URL shows in a monospace block with the host in bold. Each warning adds a line, for example "This address uses look-alike characters."
  - A blocked URL or an `Unsupported` field hides Submit/Open and says why, for example "Zorvo opens only https links, or http on this Mac."
  - `opened`: "Opened in your browser." plus **Open again**. `completed`: "Finished in your browser."
  - Other statuses show a one-line summary: "You sent the form.", "You declined.", "You dismissed this request.", "This request was not answered."
- `ElicitationFields.tsx`: one control per field, pre-filled from `default`.

  | Field | Control |
  |---|---|
  | text | `input` (`type=email` / `url` by format) |
  | `date` | `type=date` |
  | `date-time` | `type=datetime-local`, sent as RFC 3339 with the local offset |
  | number | `type=number` (`step=1` for integer) |
  | boolean | checkbox |
  | single select | radio group up to 4 options, otherwise `select` |
  | multi-select | checkbox group |

  Client-side checks are required, length, min/max, integer, item counts
  and formats, shown inline under the field. `errors` from the backend show
  the same way. Every control uses tokens, `focus-ring`, and `ui/Button`.
  Values live in the card's local state only.

### Engine (`useAcpSessions.ts`, `useAcpEngine.ts`)

- `useAcpSessions` handles the `elicitation` and `elicitation-complete` event
  kinds and exposes `respondElicitation(sessionId, key, action, content?)` and
  `reopenElicitationUrl(sessionId, key)`.
- `useAcpEngine.respondElicitation` sets the new status optimistically
  (`submitted`, `opened`, `declined`, `dismissed`).
  - An `ELICITATION_INVALID:` error sets the card back with `errors`.
  - "can no longer be answered" marks it `unanswered` and reports the error.
  - Any other error sets it back to `pending` and reports the error.
- `interrupt` marks pending elicitations `dismissed` (the backend answered
  `cancel`).
- `stop` and `exit` mark them `unanswered`. A turn end leaves them alone.

### Popouts

`PopoutAction` gains
`{ kind: 'respond-elicitation'; key; action; content? }` and
`{ kind: 'reopen-elicitation-url'; key }`. The content travels in the Tauri
event to the main window, in memory, and is never stored.

### Persistence (`src/lib/persistence.ts`)

On load, a `pending` or `opened` elicitation becomes `unanswered`, without
`fields`, `url` or `errors`; the backend no longer knows its key.

## Error handling

| Situation | Answer to the agent | UI |
|---|---|---|
| Unknown or unadvertised mode, malformed params | `-32602` | no card |
| No session to show it in (fork on a shared connection, probe, `authenticate`) | `{action:"cancel"}` | no card |
| Unknown field type, blocked URL | waits for Decline/Dismiss | card without Submit/Open |
| Rust validation fails | none yet | field errors, card stays open |
| `open` fails | none yet | error reported, card stays open |
| Key unknown (already answered, agent gone) | — | "This request can no longer be answered.", card unanswered |
| Start fails or times out with a card open | dropped | card unanswered, plus the usual start error |
| `elicitation/complete` with an unknown or finished id | ignored | — |

## Testing

**Rust unit tests (`acp/elicitation/`).**
- Parsing: each field kind, `oneOf`/`anyOf` titles, defaults, a missing
  `type` read as object, unknown types as `Unsupported`, an unknown mode as an
  error.
- `check_url`: https allowed; http to loopback allowed; public http, `file:`,
  `mailto:` and `javascript:` blocked; Punycode, IP and user-info warnings.
- `validate`: required, lengths, bounds, integers, options, item counts,
  formats, `pattern` (including a pathological pattern that stays fast or is
  refused by the size limit), unknown properties removed, and a check that no
  error message contains the submitted value.

**Rust integration tests** (`tests/acp_manager_test.rs`). The fake agent
(`fake_acp_agent.mjs`) gets switches to send `elicitation/create` and
`elicitation/complete`.
- The capability is advertised.
- A session-scoped request reaches its session.
- A request sent during `session/new` reaches the session being started.
- An unadvertised mode gets `-32602`.
- A valid form accept reaches the agent; an invalid one does not.
- `cancel()` answers open requests with `cancel`.
- A probe answers `cancel`.
- An unknown `elicitation/complete` is ignored.
- Event payload shapes are covered in `commands.rs`.

**Vitest (`src/test/`).**
- `acp-elicitation`: attach, resolve, strip on finish, unanswered.
- `ElicitationCard`: every field kind, defaults, inline errors, URL host,
  warnings and blocked state, Unsupported hiding Submit, and each button
  calling the engine with the right action.
- Engine: an `ELICITATION_INVALID` error reopens with errors; interrupt
  dismisses.
- Persistence: pending becomes unanswered, without `url` or `fields`.
- Privacy: after submitting, the typed values appear nowhere in the persisted
  store (`__FAKE_TAURI_STORE__`).
- The existing design-system tests cover tokens and contrast.

## Documentation

- `CHANGELOG.md` `Unreleased`: "Agents can ask you for input in a form or
  send you to a web page to sign in (ACP elicitation)."
- `CLAUDE.md`: an **Elicitation** paragraph under Architecture covering the
  backend-owned pending store, the key-only UI contract, and the privacy rule.
- README privacy section: an elicitation URL opens in your browser; Zorvo
  makes no request for it.

## Out of scope

- `toolCallId` linking a card to a tool row (the id is accepted, not shown).
- Request-scoped elicitations outside `start`/`load` (answered `cancel`).
- ACP v2 elicitation changes.
