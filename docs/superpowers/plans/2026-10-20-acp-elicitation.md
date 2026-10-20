# ACP Elicitation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An ACP agent can ask the user for input through a form card in the chat, or ask to open a web page in their browser, and gets `accept`/`decline`/`cancel` back.

**Architecture:** The Rust backend owns every open request. It parses
`elicitation/create` into typed fields, checks URLs, keeps the request under
a Zorvo-made key, validates submitted content against its own copy of the
schema, and opens URLs itself. The webview renders a view and sends back only
the key, an action and, for a form, the content. Typed values live only in
the card's React state and the command call.

**Tech Stack:** Rust (serde_json, `url`, `regex`), Tauri 2 commands and events, React 19, Tailwind 4 tokens, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-20-acp-elicitation-design.md`

**Precondition:** PR #57 (`fix/acp-answer-every-request`) is merged into
`main`, and this branch is rebased onto it. This plan assumes its shape:
`AcpConnection::spawn(…, make_sink: impl FnOnce(Weak<AcpConnection>) -> EventSink)`,
`route_event(routes, sink, connection: &Weak<AcpConnection>, connection_key, event)`,
and the helpers `answer(connection, reply)` and `refuse(connection, id)` in
`manager.rs`.

## Global Constraints

- The UI never sends a URL, a schema or a JSON-RPC id; only `sessionId`, `key`, `action`, `content`.
- What the user types is never stored in a transcript, `state.json`, a backend struct, an event payload or a log. Validation messages name the rule, never the value.
- The webview makes no network requests; `tauri.conf.json` CSP is unchanged.
- Advertised capability is exactly `"elicitation": { "form": {}, "url": {} }`.
- An unknown or unadvertised `mode`, or malformed params, is answered with JSON-RPC `-32602`.
- Allowed URLs: `https` to any host; `http` only to `localhost`, `127.0.0.1` or `[::1]`.
- URLs open with macOS `open` from the backend, never in the webview.
- Copy is sentence case, says "you", and names the agent. Tokens only, `ui/Button`, `focus-ring` on every control.
- Source files stay under 800 lines. `manager.rs` (about 730 lines after PR #57) gains only hooks; the elicitation logic lives in its own files.
- Commands that spawn `open` are `#[tauri::command(async)]`.
- Conventional Commits; stage explicit paths only (never `git add -A`).

## Review Focus

1. **A form that fails validation and is fixed.** After an inline error, the values the user typed must still be in the fields, and the corrected Submit must go through. Task 7 tests this.
2. **Stop with a card open during start.** Pressing Stop while `session/new` waits on a form must not leave the card pending forever, and must not throw. Task 8 tests this.
3. **A second elicitation while one is pending.** It must get its own card, and answering one must not answer the other. Tasks 5 and 3 test this.
4. **A pathological `pattern`** such as `(a+)+$` with a long input must return quickly, and a pattern Rust cannot compile (for example a lookahead) must not block the submit. Task 2 tests this.
5. **The app reloads with a card open.** On load the card must read "This request was not answered." and its URL must be gone from the saved transcript. Task 5 tests this.

---

## File Structure

**Rust (`src-tauri/`)**
- Create `src/acp/elicitation/mod.rs`: types and `parse_request`.
- Create `src/acp/elicitation/url_check.rs`: `check_url`.
- Create `src/acp/elicitation/validate.rs`: `validate`, `FieldErrors`.
- Create `src/acp/elicitation/pending.rs`: the open-request store.
- Create `src/acp/manager/elicitation_routes.rs`: a child module of `manager` (so it can reach `Routes`) with routing, respond, reopen and cancel.
- Modify `src/acp/mod.rs`, `src/acp/manager.rs`, `src/acp/commands.rs`, `src/lib.rs`, `src/windows.rs` (make `open_url` `pub(crate)`), and `Cargo.toml` (`regex = "1"`, already in `Cargo.lock` at 1.13.1).
- Modify `tests/acp_manager_test.rs` and `tests/fixtures/fake_acp_agent.mjs`.

**Frontend (`src/`)**
- Modify `types/index.ts`.
- Create `lib/acp-elicitation.ts`: transcript folding, payload parsing, `isAwaitingUser`.
- Create `lib/elicitation-form.ts`: client checks and content building.
- Create `components/chat/ElicitationCard.tsx` and `components/chat/ElicitationFields.tsx`.
- Create `hooks/session-engine/elicitation-actions.ts`.
- Modify `hooks/useAcpSessions.ts`, `hooks/session-engine/useAcpEngine.ts`, `lib/acp-events.ts` (`openReplyIndex` and the `isAwaitingPermission` callers), `lib/persistence.ts`, `lib/popout-bridge.ts`, `components/ChatCanvas.tsx`, `components/PopoutApp.tsx`, `App.tsx`, `lib/session-start.ts`, `test/setup.ts`.
- Tests in `src/test/`.

---

### Task 1: Parse `elicitation/create` and check URLs

**Files:**
- Create: `src-tauri/src/acp/elicitation/mod.rs`, `src-tauri/src/acp/elicitation/url_check.rs`
- Modify: `src-tauri/src/acp/mod.rs` (add `pub mod elicitation;`)
- Test: `#[cfg(test)]` modules in both files

**Interfaces:**
- Produces (in `acp::elicitation`):

  ```rust
  pub enum Elicitation {
      Form { message: String, fields: Vec<Field> },
      Url { message: String, elicitation_id: String, url: String, check: UrlCheck },
  }
  #[derive(Serialize)] #[serde(rename_all = "camelCase")]
  pub struct Field { pub name: String, pub title: Option<String>, pub description: Option<String>,
                     pub required: bool, pub kind: FieldKind, pub default: Option<Value> }
  #[derive(Serialize)] #[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
  pub enum FieldKind {
      Text { format: Option<String>, min_length: Option<u64>, max_length: Option<u64>,
             #[serde(skip)] pattern: Option<String> },
      Number { integer: bool, minimum: Option<f64>, maximum: Option<f64> },
      Boolean,
      Select { options: Vec<Choice> },
      MultiSelect { options: Vec<Choice>, min_items: Option<u64>, max_items: Option<u64> },
      Unsupported { raw_type: String },
  }
  #[derive(Serialize)] pub struct Choice { pub value: String, pub title: String, pub description: Option<String> }
  pub fn parse_request(params: &Value) -> Result<Elicitation, String>;
  impl Elicitation { pub fn view(&self) -> Value; }   // the UI payload, see Step 5

  // url_check.rs
  #[derive(Serialize)] #[serde(rename_all = "kebab-case")]
  pub enum UrlWarning { Punycode, IpAddress, UserInfo }
  pub struct UrlCheck { pub host: String, pub blocked: Option<String>, pub warnings: Vec<UrlWarning> }
  pub fn check_url(url: &str) -> UrlCheck;
  ```

- [ ] **Step 1: Write the failing parser tests in `mod.rs`**

  - `parses_a_form_with_every_field_kind`: a schema with `name` (string, `minLength` 2, `maxLength` 50, `format` "email", `default` "a@b.co"), `age` (integer, `minimum` 0, `maximum` 120), `ratio` (number), `agree` (boolean, `default` true), `color` (`enum` ["Red","Green"]), `tone` (`oneOf` with `const` "#f00" / `title` "Red" / `description` "Loud"), `tags` (array, `items.enum` ["a","b"], `minItems` 1, `maxItems` 2), `labels` (array, `items.anyOf` of `const`/`title`), and `required: ["name"]`. Assert the field order matches `properties`, `name.required == true`, `age` is `Number { integer: true, minimum: Some(0.0), maximum: Some(120.0) }`, `color` options have `title == value`, `tone` options carry the title and description, and `tags` is `MultiSelect` with `min_items: Some(1)`.
  - `keeps_a_default_only_when_it_fits`: a string field with `default: 5` gives `default: None`; a select with a default outside its options gives `None`.
  - `reads_a_missing_type_as_an_object_and_missing_properties_as_empty`: `{"properties": {...}}` without `type` parses; `{"type": "object"}` gives zero fields.
  - `marks_unknown_types_unsupported`: `{"type":"_x"}` and an array whose `items` is `{"type":"number"}` both give `Unsupported` with `raw_type` "_x" and "array".
  - `refuses_unknown_modes_and_malformed_requests`: `mode` "voice", a missing `mode`, a form whose `requestedSchema` is a string, `properties: null`, and a URL request without `elicitationId` are all `Err`.
  - `parses_a_url_request`: `mode` "url", `elicitationId` "gh-1", `url` "https://agent.example.com/connect", `message` "Authorize". Assert `elicitation_id`, `url`, and `check.host == "agent.example.com"`.

- [ ] **Step 2: Write the failing URL tests in `url_check.rs`**

  - `allows_https_and_loopback_http`: `https://x.dev/a`, `http://localhost:3000/cb`, `http://127.0.0.1/cb` and `http://[::1]:8080/` have `blocked == None`.
  - `blocks_everything_else`: `http://example.com`, `file:///etc/passwd`, `mailto:a@b.c`, `javascript:alert(1)`, `vscode://x` and `not a url` have `blocked.is_some()`.
  - `warns_about_lookalike_hosts`: `https://xn--pple-43d.com/` → `[Punycode]`; `https://93.184.216.34/` → `[IpAddress]`; `https://user@example.com/` → `[UserInfo]`; and `host` for the punycode URL is the ASCII form.

- [ ] **Step 3: Run the tests and confirm they fail**

  Run: `cd src-tauri && cargo test --lib acp::elicitation`
  Expected: FAIL, because the module does not exist yet.

- [ ] **Step 4: Implement `parse_request`, `check_url` and the types**

  - Read `mode` exactly. Reader tolerance follows the spec: a missing or non-string schema `type` counts as an object, missing `properties` is empty, `properties: null` is an error.
  - `check_url` uses `url::Url::parse`.
    - Loopback means `host_str()` is `localhost`, `127.0.0.1` or `[::1]`.
    - `IpAddress` means `Host::Ipv4`/`Ipv6` that is not loopback.
    - `UserInfo` means a non-empty `username()` or a `password()`.
    - `Punycode` means any host label starts with `xn--`.
    - `blocked` is one fixed message: `"Zorvo opens only https links, or http on this Mac."`

- [ ] **Step 5: Add `view()` and its test**

  `view_carries_no_pattern_and_no_elicitation_id`: the view's JSON for a form has `{"mode":"form","message":…,"fields":[…]}`, with each field's `kind.type` one of `text|number|boolean|select|multiSelect|unsupported` and no `pattern` key. A URL view is `{"mode":"url","message","url","host","warnings":["punycode"],"blocked":null}` with no `elicitationId` key.

- [ ] **Step 6: Run the tests and confirm they pass**

  Run: `cd src-tauri && cargo test --lib acp::elicitation && cargo clippy --all-targets -- -D warnings`
  Expected: PASS, no warnings.

- [ ] **Step 7: Commit**

  ```bash
  git add src-tauri/src/acp/mod.rs src-tauri/src/acp/elicitation/mod.rs src-tauri/src/acp/elicitation/url_check.rs
  git commit -m "feat: parse ACP elicitation requests and check their URLs"
  ```

### Task 2: Validate submitted form content

**Files:**
- Create: `src-tauri/src/acp/elicitation/validate.rs`
- Modify: `src-tauri/src/acp/elicitation/mod.rs` (`mod validate; pub use validate::{validate, FieldErrors};`), `src-tauri/Cargo.toml` (`regex = "1"`)
- Test: `#[cfg(test)]` in `validate.rs`

**Interfaces:**
- Consumes: `Field`, `FieldKind` from Task 1.
- Produces:
  - `pub type FieldErrors = BTreeMap<String, String>;`
  - `pub fn validate(fields: &[Field], content: &Value) -> Result<Value, FieldErrors>`. The `Ok` value is an object holding only the known fields that are present.

Messages, used verbatim by Rust and TypeScript (Task 6):

| Rule | Message |
|---|---|
| required and missing or `""` | `This field is required.` |
| `minLength` / `maxLength` (chars) | `Use at least {n} characters.` / `Use at most {n} characters.` |
| not a number | `Use a number.` |
| integer | `Use a whole number.` |
| `minimum` / `maximum` | `Use {n} or more.` / `Use {n} or less.` |
| not a boolean | `Use yes or no.` |
| `email` | `Use an email address.` |
| `uri` | `Use a full web address.` |
| `date` | `Use a date.` |
| `date-time` | `Use a date and time.` |
| `pattern` | `Use the format the agent asked for.` |
| select value not an option | `Pick one of the options.` |
| `minItems` / `maxItems` | `Pick at least {n}.` / `Pick at most {n}.` |
| `Unsupported` field | `Zorvo cannot show this field.` |

`{n}` prints whole numbers without `.0`.

- [ ] **Step 1: Write the failing tests**

  - `accepts_valid_content_and_drops_unknown_fields`: valid values for every kind plus `"extra": 1` returns `Ok` without `extra`.
  - `reports_each_rule`: one case per table row asserts `errors[field] == message`.
  - `checks_formats`:
    - `email`: "a@b.co" ok; "a@b", "@b.co", "a@@b.co" fail.
    - `uri`: "https://x.y" ok; "x.y" fails.
    - `date`: "2026-10-20" ok; "2026-13-01" and "20-10-2026" fail.
    - `date-time`: "2026-10-20T09:30:00+07:00" and "2026-10-20T02:30:00Z" ok; "2026-10-20T09:30" fails.
  - `treats_unknown_formats_as_annotations`: `format` "phone" with any string is ok.
  - `checks_pattern_with_bounded_time`:
    - `pattern` "^[a-z]+$": "abc" ok, "ab1" fails.
    - `(a+)+$` against `"a".repeat(50_000) + "!"` returns within 1 second (assert `Instant` elapsed < 1 s).
    - The lookahead `^(?=a)a$` (Rust cannot compile it) and a 2,000-char pattern are skipped, so "zzz" is ok.
  - `refuses_a_form_with_an_unsupported_field`: `errors[name] == "Zorvo cannot show this field."` even when the content omits it.
  - `never_echoes_the_value`: for every failing case above, no message contains the submitted string.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `cd src-tauri && cargo test --lib acp::elicitation::validate`
  Expected: FAIL (not defined).

- [ ] **Step 3: Implement `validate`**

  - Compile the pattern with `regex::RegexBuilder::new(p).size_limit(1 << 20).dfa_size_limit(1 << 20).build()`, only when `p.len() <= 1000`. Match unanchored, with JSON Schema semantics.
  - Formats use simple shape checks, without new crates. `date` checks the month (1-12) and day (1-31) ranges. `date-time` is RFC 3339 with seconds and a `Z` or `±HH:MM` offset.
  - `""` counts as missing.

- [ ] **Step 4: Run them and confirm they pass**

  Run: `cd src-tauri && cargo test --lib acp::elicitation && cargo clippy --all-targets -- -D warnings`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/acp/elicitation/mod.rs src-tauri/src/acp/elicitation/validate.rs
  git commit -m "feat: validate elicitation form content against the agent's schema"
  ```

### Task 3: Advertise elicitation, keep open requests, route them to sessions

**Files:**
- Create: `src-tauri/src/acp/elicitation/pending.rs`, `src-tauri/src/acp/manager/elicitation_routes.rs`
- Modify: `src-tauri/src/acp/manager.rs`, `src-tauri/src/acp/commands.rs` (`event_payload`), `src-tauri/tests/fixtures/fake_acp_agent.mjs`, `src-tauri/tests/acp_manager_test.rs`

**Interfaces:**
- Consumes: `parse_request`, `Elicitation::view` (Task 1).
- Produces:

  ```rust
  // pending.rs
  pub enum PendingState { Open, AwaitingCompletion }
  pub struct Pending { pub app_session_id: String, pub connection: Weak<AcpConnection>, pub connection_key: u64,
                       pub request_id: Value, pub elicitation: Elicitation, pub state: PendingState }
  #[derive(Default)] pub struct PendingElicitations { /* key -> Pending, next key counter */ }
  impl PendingElicitations {
      pub fn insert(&mut self, pending: Pending) -> String;               // returns "el-<n>"
      pub fn get(&self, app_session_id: &str, key: &str) -> Option<&Pending>;
      pub fn get_mut(&mut self, app_session_id: &str, key: &str) -> Option<&mut Pending>;
      pub fn remove(&mut self, key: &str) -> Option<Pending>;
      pub fn take_completed(&mut self, connection_key: u64, elicitation_id: &str) -> Option<(String, Pending)>; // only AwaitingCompletion
      pub fn take_session(&mut self, app_session_id: &str) -> Vec<Pending>;
  }
  // manager.rs
  pub enum AcpEvent { …, Elicitation { session_id: String, key: String, view: Value },
                          ElicitationComplete { session_id: String, key: String } }
  ```

  - `Routes` gains `opening: HashMap<u64, String>` (connection key → app session id) and `elicitations: PendingElicitations`.
  - `event_payload` maps the two new events to `{sessionId, kind:"elicitation", key, request: view}` and `{sessionId, kind:"elicitation-complete", key}`.

- [ ] **Step 1: Extend the fake agent**

  In `fake_acp_agent.mjs`:
  - Record the `initialize` params' `clientCapabilities` to the file in `FAKE_ACP_INIT_LOG` when that is set.
  - Add magic prompts, each sending `elicitation/create` with `id` "elic-1" (and "elic-2") for the prompt's session, then echoing the answer as `say(sessionId, "elicited:" + JSON.stringify(result ?? error))` when the reply arrives. After that it replies to the prompt with `end_turn`.
    - `elicit-form`: form mode, schema `{type:"object",properties:{name:{type:"string",maxLength:5}},required:["name"]}`.
    - `elicit-url`: url mode, `elicitationId` "gh-1", `url` "https://agent.example.com/connect".
    - `elicit-voice`: `mode` "voice".
    - `elicit-twice`: two form requests, "elic-1" and "elic-2".
    - `elicit-complete`: sends `elicitation/complete {elicitationId:"gh-1"}` and `{elicitationId:"nope"}`, then says "completed-sent".
  - `FAKE_ACP_ELICIT_ON_NEW`: `session/new` first sends `elicitation/create` with `requestId` set to the `session/new` id (form mode), and answers `session/new` only after the client replies, or with an error after 3 s.

- [ ] **Step 2: Write the failing integration tests in `acp_manager_test.rs`**

  - `advertises_form_and_url_elicitation`: the init log has `clientCapabilities.elicitation == {"form":{},"url":{}}`.
  - `routes_a_form_request_to_its_session`: prompt `elicit-form` gives `AcpEvent::Elicitation { session_id: "s-1", key, view }` with `key` starting "el-" and `view["fields"][0]["name"] == "name"`.
  - `refuses_an_unknown_mode_with_invalid_params`: prompt `elicit-voice`, and the agent says text containing `"code":-32602`.
  - `shows_a_request_sent_while_the_session_opens`: start with `FAKE_ACP_ELICIT_ON_NEW` on one thread while the test thread waits for `AcpEvent::Elicitation { session_id: "s-1", .. }`. (The start completes in Task 4; here, assert only the event and then `manager.stop("s-1")`.)
  - `cancels_requests_from_unrouted_agents`: `manager.probe(&cwd(), &launch, true)` with `FAKE_ACP_ELICIT_ON_NEW` returns `Ok`. The fake's `session/new` gets `{action:"cancel"}` and answers normally, and no `Elicitation` event is sent.
  - `keeps_two_requests_apart`: prompt `elicit-twice` gives two events with different keys.
  - `ignores_unknown_completions`: prompt `elicit-complete` gives "completed-sent" and no `ElicitationComplete` event.
  - In `commands.rs` tests, `elicitation_events_carry_the_key_and_view`: the payloads of both new events.

- [ ] **Step 3: Run them and confirm they fail**

  Run: `cd src-tauri && cargo test --test acp_manager_test elicit && cargo test --lib acp::commands`
  Expected: FAIL.

- [ ] **Step 4: Implement**

  1. In `initialize()`, add `"elicitation": { "form": {}, "url": {} }` to `clientCapabilities`.
  2. In `open()`, insert `opening[connection_key] = app_session_id` right after spawn. Remove it after `register` or on failure. On failure, also `take_session(app_session_id)`, so no card can be answered later.
  3. In `route_event`, send `("elicitation/create", _)` to `elicitation_routes::route_create(routes, sink, connection, connection_key, id, params)`.
  4. Send `ConnectionEvent::Notification` with method `elicitation/complete` to `route_complete(routes, sink, connection_key, params)`.
  5. `route_create` handles each request:
     - On a parse error, `respond_error(id, -32602, msg)`.
     - Otherwise find the app session: a registered `sessionId`, else `opening[connection_key]`, else `answer(…, respond(id, {"action":"cancel"}))`.
     - Then insert `Pending { state: Open }` and emit `AcpEvent::Elicitation`.
  6. `route_complete` calls `take_completed`, then emits `ElicitationComplete`. Unknown ids do nothing.
  7. `spawn_unrouted` answers `elicitation/create` with `{"action":"cancel"}` and every other request as today.
  8. `stop()` and the `Exited` arm `take_session` each removed session.
  9. Add `mod elicitation_routes;` at the top of `manager.rs`. It is a child module, so it sees `Routes` and its private fields.

- [ ] **Step 5: Run them and confirm they pass**

  Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
  Expected: PASS, including every existing test (PR #57's early-request tests included).

- [ ] **Step 6: Commit**

  ```bash
  git add src-tauri/src/acp/elicitation/pending.rs src-tauri/src/acp/elicitation/mod.rs src-tauri/src/acp/manager.rs src-tauri/src/acp/manager/elicitation_routes.rs src-tauri/src/acp/commands.rs src-tauri/tests/acp_manager_test.rs src-tauri/tests/fixtures/fake_acp_agent.mjs
  git commit -m "feat: advertise ACP elicitation and route requests to sessions"
  ```

### Task 4: Answer, open, reopen and cancel elicitations

**Files:**
- Modify: `src-tauri/src/acp/manager/elicitation_routes.rs`, `src-tauri/src/acp/manager.rs`, `src-tauri/src/acp/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/windows.rs`, `src-tauri/tests/acp_manager_test.rs`

**Interfaces:**
- Consumes: Task 2's `validate`, Task 3's store and events.
- Produces:

  ```rust
  pub const ELICITATION_INVALID_PREFIX: &str = "ELICITATION_INVALID:";
  pub const ELICITATION_GONE: &str = "This request can no longer be answered.";
  pub type UrlOpener = Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>;
  impl AcpManager {
      pub fn with_url_opener(sink: AcpEventSink, opener: UrlOpener) -> Self; // new() = with_url_opener(sink, Box::new(crate::windows::open_url))
      pub fn respond_elicitation(&self, app_session_id: &str, key: &str, action: &str, content: Option<Value>) -> Result<(), String>;
      pub fn reopen_elicitation_url(&self, app_session_id: &str, key: &str) -> Result<(), String>;
  }
  #[tauri::command(async)] pub fn acp_respond_elicitation(manager, session_id: String, key: String, action: String, content: Option<Value>) -> Result<(), String>;
  #[tauri::command(async)] pub fn acp_reopen_elicitation_url(manager, session_id: String, key: String) -> Result<(), String>;
  ```

  `respond_elicitation` errors:
  - an unknown key, or one that is not `Open` → `ELICITATION_GONE`;
  - an action other than `accept`/`decline`/`cancel` → `"Unknown answer"`;
  - a blocked URL accept → its `blocked` message;
  - a form that fails validation → `ELICITATION_INVALID_PREFIX + serde_json::to_string(&errors)`.

- [ ] **Step 1: Write the failing integration tests**

  Use `AcpManager::with_url_opener` with an opener that records URLs into an `Arc<Mutex<Vec<String>>>`.

  - `sends_a_valid_form_to_the_agent`: prompt `elicit-form`; `respond_elicitation("s-1", key, "accept", Some(json!({"name":"Ada"})))`; the agent says `elicited:{"action":"accept","content":{"name":"Ada"}}`.
  - `keeps_an_invalid_form_open`: content `{"name":"Adalovelace"}` gives an `Err` starting with `ELICITATION_INVALID:` whose JSON is `{"name":"Use at most 5 characters."}`. No "elicited:" text arrives within 500 ms, and a following valid accept succeeds.
  - `declines_and_dismisses`: `decline` gives `{"action":"decline"}`. For `elicit-twice`, `cancel` on the first key gives `{"action":"cancel"}` for "elic-1" only.
  - `opens_the_backends_url_on_accept`: prompt `elicit-url`, accept with `content: Some(json!({"url":"https://evil.example"}))`. The opener got exactly `["https://agent.example.com/connect"]`, and the agent got `{"action":"accept"}` with no `content`.
  - `does_not_answer_when_the_url_cannot_open`: an opener returning `Err("no browser")` gives that `Err` and no answer; after flipping the opener to succeed (an `AtomicBool` it reads), the same accept succeeds and the agent gets `{"action":"accept"}`.
  - `reopens_and_completes_a_url_request`: after accept, `reopen_elicitation_url` opens it again. Prompt `elicit-complete` gives `ElicitationComplete { key }` once. A second reopen gives `Err(ELICITATION_GONE)`.
  - `refuses_a_second_answer`: answering the same key twice gives `Err(ELICITATION_GONE)`.
  - `stop_answers_open_requests_with_cancel`: prompt `elicit-form`, then `manager.cancel("s-1")`; the agent says `elicited:{"action":"cancel"}` before the turn ends.
  - `answers_a_request_sent_while_the_session_opens`: `FAKE_ACP_ELICIT_ON_NEW`, with start on a spawned thread. On the `Elicitation` event, accept `{"name":"Ada"}`, and the start returns `Ok` with `acp_session_id == "fake-1"`.
  - `drops_requests_when_the_session_stops`: after `stop("s-1")`, `respond_elicitation` gives `Err(ELICITATION_GONE)`.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `cd src-tauri && cargo test --test acp_manager_test elicit`
  Expected: FAIL (methods missing).

- [ ] **Step 3: Implement**

  1. `respond_elicitation` takes the `Pending` out of `Routes` under the lock, then works without holding it. A form accept validates first; on `Err` the `Pending` goes back unchanged. A URL accept runs the opener first; on `Err` it goes back unchanged. On success it stays as `AwaitingCompletion`.
  2. `reopen_elicitation_url` requires `AwaitingCompletion`.
  3. `cancel()` takes the session's `Open` requests, answers each `{"action":"cancel"}`, then sends `session/cancel` as before. `AwaitingCompletion` entries stay.
  4. Make `windows::open_url` `pub(crate)`.
  5. Register both commands in `lib.rs`'s `generate_handler!` next to `acp_respond_permission`.

- [ ] **Step 4: Run them and confirm they pass**

  Run: `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check && wc -l src/acp/manager.rs`
  Expected: PASS, and `manager.rs` < 800 lines.

- [ ] **Step 5: Commit**

  ```bash
  git add src-tauri/src/acp/manager.rs src-tauri/src/acp/manager/elicitation_routes.rs src-tauri/src/acp/commands.rs src-tauri/src/lib.rs src-tauri/src/windows.rs src-tauri/tests/acp_manager_test.rs
  git commit -m "feat: answer elicitations, open their URLs and cancel them on stop"
  ```

### Task 5: Elicitation cards in the transcript

**Files:**
- Modify: `src/types/index.ts`, `src/lib/acp-events.ts`, `src/lib/persistence.ts`
- Create: `src/lib/acp-elicitation.ts`
- Test: `src/test/acp-elicitation.test.ts`, `src/test/persistence.test.ts`

**Interfaces:**
- Produces (`types/index.ts`):

  ```ts
  export type ElicitationFieldKind =
    | { type: 'text'; format?: string; minLength?: number; maxLength?: number }
    | { type: 'number'; integer: boolean; minimum?: number; maximum?: number }
    | { type: 'boolean' }
    | { type: 'select'; options: ElicitationChoice[] }
    | { type: 'multiSelect'; options: ElicitationChoice[]; minItems?: number; maxItems?: number }
    | { type: 'unsupported'; rawType: string };
  export interface ElicitationChoice { value: string; title: string; description?: string }
  export interface ElicitationField { name: string; title?: string; description?: string; required: boolean; kind: ElicitationFieldKind; default?: unknown }
  export type ElicitationStatus = 'pending' | 'submitted' | 'declined' | 'dismissed' | 'opened' | 'completed' | 'unanswered';
  export interface ElicitationCard { key: string; sessionId: string; mode: 'form' | 'url'; message: string; status: ElicitationStatus; timestamp: number;
    fields?: ElicitationField[]; url?: string; host?: string; warnings?: ('punycode' | 'ip-address' | 'user-info')[]; blocked?: string;
    errors?: Record<string, string> }
  // ChatMessage gains: elicitation?: ElicitationCard;
  ```

- Produces (`lib/acp-elicitation.ts`):
  - `ELICITATION_INVALID_PREFIX`
  - `ELICITATION_GONE`
  - `parseInvalidElicitation(error: unknown): Record<string, string> | null`
  - `toElicitationCard(sessionId: string, key: unknown, request: unknown, now: number): ElicitationCard | null` (shape-checks the untrusted payload; null when malformed)
  - `applyElicitation(messages, card, ctx: AcpReducerContext): ChatMessage[]`
  - `setElicitationStatus(messages, key, status: ElicitationStatus): ChatMessage[]`
  - `rejectElicitationSubmit(messages, key, errors): ChatMessage[]`
  - `completeElicitation(messages, key): ChatMessage[]` (only from `opened`)
  - `dismissPendingElicitations(messages): ChatMessage[]`
  - `markElicitationsUnanswered(messages): ChatMessage[]` (`pending` and `opened` → `unanswered`)
  - `isAwaitingUser(messages): boolean`
  - `hasPendingElicitation(messages): boolean`

  Once a status is not `pending`, `fields`, `url` and `errors` are removed; `host` stays.

- [ ] **Step 1: Write the failing tests in `acp-elicitation.test.ts`**

  - `builds_a_card_from_a_form_payload` and `returns_null_for_malformed_payloads` (a missing key, a missing mode, fields not being an array, an unknown `kind.type` dropped from the list).
  - `attaches_to_the_open_reply`, `starts_a_new_reply_when_the_open_one_already_has_an_elicitation`, and `starts_a_new_reply_after_a_finished_turn`.
  - `keeps_two_cards_apart`: setting one key's status leaves the other `pending`.
  - `strips_fields_and_url_once_answered`: after `setElicitationStatus(…, 'opened')`, `url` is gone and `host` is kept; after `'submitted'`, `fields` is gone.
  - `rejectElicitationSubmit` puts the card back to `pending` with `errors`; `parseInvalidElicitation('ELICITATION_INVALID:{"name":"Use a date."}')` gives the map; other strings give `null`.
  - `completeElicitation` moves `opened` to `completed` and leaves other statuses alone.
  - `isAwaitingUser`: true for a pending permission card, true for a pending elicitation even before the last user message, false otherwise.
  - `closeTurn` leaves a pending elicitation pending (import from `acp-events`).

- [ ] **Step 2: Write the failing persistence test**

  In `persistence.test.ts`, `loadTranscript settles open elicitations`: seed a transcript holding a `pending` form card and an `opened` URL card with `url`. After loading, both are `unanswered`, without `fields`, `url` or `errors`, and `host` is kept.

- [ ] **Step 3: Run them and confirm they fail**

  Run: `pnpm vitest run src/test/acp-elicitation.test.ts src/test/persistence.test.ts`
  Expected: FAIL.

- [ ] **Step 4: Implement**

  - `openReplyIndex` in `acp-events.ts` treats a reply holding a pending elicitation like one holding a pending permission card (still open).
  - Export `isAwaitingUser` from `acp-elicitation.ts`, and keep `isAwaitingPermission` only if still used internally.
  - `loadTranscript` returns `markElicitationsUnanswered(messages)`.

- [ ] **Step 5: Run them and confirm they pass**

  Run: `pnpm vitest run src/test/acp-elicitation.test.ts src/test/persistence.test.ts src/test/acp-events.test.ts && pnpm lint`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add src/types/index.ts src/lib/acp-elicitation.ts src/lib/acp-events.ts src/lib/persistence.ts src/test/acp-elicitation.test.ts src/test/persistence.test.ts
  git commit -m "feat: keep elicitation cards in the transcript without their values"
  ```

### Task 6: Client-side form checks and content

**Files:**
- Create: `src/lib/elicitation-form.ts`
- Test: `src/test/elicitation-form.test.ts`

**Interfaces:**
- Consumes: `ElicitationField` (Task 5).
- Produces:
  - `export type FormValue = string | boolean | string[];` (number and date inputs hold strings)
  - `initialValues(fields: ElicitationField[]): Record<string, FormValue>`
  - `checkForm(fields: ElicitationField[], values: Record<string, FormValue>): Record<string, string>` (no `pattern`)
  - `toContent(fields: ElicitationField[], values: Record<string, FormValue>, offsetMinutes?: number): Record<string, unknown>`
  - `canSubmit(fields: ElicitationField[]): boolean` (false when any field is `unsupported`)

  Messages are the exact strings from Task 2's table.

- [ ] **Step 1: Write the failing tests**

  - `initialValues`: defaults pre-fill (string, boolean, select, multi); without a default, text gives `''`, boolean gives `false`, multi gives `[]`.
  - `checkForm`: one case per rule from Task 2's table (except `pattern` and `Unsupported`), asserting the exact message.
  - `toContent`:
    - numbers become JSON numbers;
    - an empty optional text, number or select is omitted;
    - a `date-time` value "2026-10-20T09:30" with `offsetMinutes` 420 gives "2026-10-20T09:30:00+07:00", and with 0 gives "2026-10-20T09:30:00Z";
    - multi-select stays an array.
  - `canSubmit` is false with an unsupported field.

- [ ] **Step 2: Run them and confirm they fail**

  Run: `pnpm vitest run src/test/elicitation-form.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.** `offsetMinutes` defaults to `-new Date().getTimezoneOffset()`.

- [ ] **Step 4: Run them and confirm they pass.** Same command; PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/elicitation-form.ts src/test/elicitation-form.test.ts
  git commit -m "feat: check elicitation forms in the UI before sending"
  ```

### Task 7: The elicitation card

**Files:**
- Create: `src/components/chat/ElicitationCard.tsx`, `src/components/chat/ElicitationFields.tsx`
- Test: `src/test/elicitation-card.test.tsx`

**Interfaces:**
- Consumes: Tasks 5 and 6.
- Produces:

  ```ts
  export type ElicitationAnswer = { action: 'accept'; content?: Record<string, unknown> } | { action: 'decline' } | { action: 'cancel' };
  export interface ElicitationCardProps {
    card: ElicitationCard; agentName: string;
    onAnswer?: (key: string, answer: ElicitationAnswer) => void;
    onReopen?: (key: string) => void;
    disabled?: boolean;
  }
  export function ElicitationCard(props: ElicitationCardProps): JSX.Element;
  ```

  Copy (exact):

  | Where | Text |
  |---|---|
  | Form title | `${agentName} asks for input` |
  | URL title | `${agentName} wants to open a page` |
  | Form buttons | `Submit` (primary), `Decline`, `Dismiss` |
  | URL buttons | `Open in browser` (primary), `Decline`, `Dismiss` |
  | `punycode` warning | `This address uses look-alike characters.` |
  | `ip-address` warning | `This address is a bare IP address.` |
  | `user-info` warning | `This address hides a name before the @.` |
  | Can't submit | `This form has a field Zorvo cannot show. You can decline or dismiss it.` |
  | `opened` | `Opened in your browser.` and button `Open again` |
  | `completed` | `Finished in your browser.` |
  | `submitted` / `declined` / `dismissed` / `unanswered` | `You sent the form.` / `You declined.` / `You dismissed this request.` / `This request was not answered.` |

  Controls follow the spec's table. A radio group has up to 4 options, otherwise a `select`. Each control is labelled with `title ?? name`, followed by a required marker and the description as help text (`aria-describedby`). Errors show under the field with `role="alert"`. Classes use tokens only and `focus-ring`. The container has `data-testid={\`elicitation-card-${card.key}\`}` and the same attention styling as `ActionCard`.

- [ ] **Step 1: Write the failing tests**

  - `renders_every_field_kind_with_defaults`: a form with text (email), integer, boolean (default true), a 3-option select (radios), a 6-option select (combobox), multi-select (checkboxes), date and date-time. Assert the controls by role and label, the pre-filled defaults, and that the agent's message renders as plain text (a URL inside it is not a link: `queryByRole('link')` is null).
  - `shows_client_errors_and_keeps_typed_values`: type "x" in a field with `minLength` 2, click Submit. `onAnswer` is not called, the alert reads "Use at least 2 characters.", and the input still holds "x". Then type "xy" and click Submit: `onAnswer(key, {action:'accept', content:{…}})`.
  - `shows_backend_errors_from_the_card`: `card.errors = {name: "Use the format the agent asked for."}` shows under `name`.
  - `decline_and_dismiss_send_their_actions`.
  - `url_card_shows_the_full_url_and_host_and_warnings`: the full URL text, `host` in a `strong`, the punycode warning, and **Open in browser** calls `onAnswer(key, {action:'accept'})` with no content.
  - `blocked_url_offers_no_open`: no **Open in browser**, and the blocked message shows.
  - `unsupported_field_offers_no_submit`.
  - `answered_cards_show_a_summary`: each non-pending status shows its line. For `opened`, **Open again** calls `onReopen(key)`.
  - `privacy`: render, type "secret-value", submit, then rerender with the card's status `submitted`. `container.textContent` no longer contains "secret-value".

- [ ] **Step 2: Run them and confirm they fail**

  Run: `pnpm vitest run src/test/elicitation-card.test.tsx`
  Expected: FAIL.

- [ ] **Step 3: Implement both components.** `ElicitationFields` is a controlled component: `{fields, values, errors, onChange, disabled}`. `ElicitationCard` holds `values` in `useState(initialValues(fields))` and runs `checkForm` before `toContent`.

- [ ] **Step 4: Run them and confirm they pass**

  Run: `pnpm vitest run src/test/elicitation-card.test.tsx src/test/design-tokens.test.ts src/test/theme-contrast.test.ts && pnpm lint`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/components/chat/ElicitationCard.tsx src/components/chat/ElicitationFields.tsx src/test/elicitation-card.test.tsx
  git commit -m "feat: show elicitation forms and URL requests as chat cards"
  ```

### Task 8: Wire it through the engine, chat, popouts and docs

**Files:**
- Create: `src/hooks/session-engine/elicitation-actions.ts`, `src/test/use-acp-elicitation.test.tsx`
- Modify: `src/hooks/useAcpSessions.ts`, `src/hooks/session-engine/useAcpEngine.ts`, `src/components/ChatCanvas.tsx`, `src/components/PopoutApp.tsx`, `src/lib/popout-bridge.ts`, `src/App.tsx`, `src/lib/session-start.ts`, `src/test/setup.ts`, `src/test/popout.test.tsx`, `CHANGELOG.md`, `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: the commands from Task 4 and Tasks 5–7.
- Produces:
  - `AcpHandlers` gains `onElicitation(sessionId, card: ElicitationCard)` and `onElicitationComplete(sessionId, key: string)`.
  - `useAcpSessions` returns `respondElicitation(sessionId, key, answer: ElicitationAnswer): Promise<void>` (invoke `acp_respond_elicitation` with `{sessionId, key, action, content}`) and `reopenElicitationUrl(sessionId, key): Promise<void>`.
  - `elicitationActions({ acp, updateMessages, reportError }) => { answer(sessionId, key, answer): void; reopen(sessionId, key): void }`, exposed on the engine as `answerElicitation` and `reopenElicitationUrl`.
  - `PopoutAction` gains `{ kind: 'answer-elicitation'; key: string; answer: ElicitationAnswer }` and `{ kind: 'reopen-elicitation-url'; key: string }`.
  - `ChatCanvas` gains `onAnswerElicitation?(key, answer)` and `onReopenElicitationUrl?(key)`.

Behaviour of `answer`:
- It first sets the status optimistically: `accept` on a form → `submitted`, on a URL → `opened`; `decline` → `declined`; `cancel` → `dismissed`.
- `parseInvalidElicitation(error)` → `rejectElicitationSubmit` with those errors.
- An error equal to `ELICITATION_GONE` → `unanswered`, plus `reportError(ELICITATION_GONE)`.
- Any other error → back to `pending`, plus `reportError(\`Could not answer the agent: ${error}\`)`.

Because the card was stripped on the optimistic step, the engine keeps the pending card in a `useRef` map by key until the call settles. That lets it restore `fields`/`url` on failure.

- [ ] **Step 1: Fake the commands in `src/test/setup.ts`**

  `acp_respond_elicitation` and `acp_reopen_elicitation_url` resolve `undefined` by default. A test can override them with the existing per-test invoke override pattern.

- [ ] **Step 2: Write the failing tests in `use-acp-elicitation.test.tsx`**

  Render the app the way `acp-app.test.tsx` does, and emit `acp-event` payloads through its listener helper.
  - `shows_a_card_and_sends_the_answer`: an `elicitation` event shows the card. Fill the form and Submit: invoke was called with `{sessionId, key, action:'accept', content:{name:'Ada'}}`, and the card reads "You sent the form.".
  - `reopens_with_field_errors`: invoke rejects with `ELICITATION_INVALID:{"name":"Use the format the agent asked for."}`. The card is pending again and shows that error under `name`.
  - `marks_a_gone_request_unanswered`.
  - `stop_dismisses_open_cards`: pressing Stop calls `acp_cancel`, and the card reads "You dismissed this request.".
  - `exit_and_failed_start_leave_cards_unanswered`: an `exit` event, and separately an `acp_start_session` that rejects after an elicitation event arrived.
  - `completion_finishes_an_opened_card`: accept a URL card, then an `elicitation-complete` event shows "Finished in your browser.".
  - `marks_the_session_as_waiting`: the sidebar/background "needs approval" state turns on while a card is pending, and the attention notification fires with reason `needs-answer`.
  - `never_persists_typed_values`: type "secret-value", submit, flush persistence, and `JSON.stringify(window.__FAKE_TAURI_STORE__)` does not contain "secret-value".
  - In `popout.test.tsx`: a popout's Submit emits `popout-action` with `kind: 'answer-elicitation'`, and the host forwards it to `acp_respond_elicitation`.

- [ ] **Step 3: Run them and confirm they fail**

  Run: `pnpm vitest run src/test/use-acp-elicitation.test.tsx src/test/popout.test.tsx`
  Expected: FAIL.

- [ ] **Step 4: Implement the wiring**

  - `useAcpSessions` parses the two event kinds with `toElicitationCard`, ignoring a null result.
  - In `useAcpEngine`:
    - `onElicitation`: `applyElicitation`, plus `onAttention(sessionId, 'needs-answer')`.
    - `onElicitationComplete`: `completeElicitation`.
    - `interrupt`: `dismissPendingElicitations` after `acp.cancel` resolves (the backend answered them). While the session is still starting, `markElicitationsUnanswered`.
    - `onExit` and the `open()` catch in `launch`: `markElicitationsUnanswered`.
  - Replace the `isAwaitingPermission` callers in `App.tsx` and `session-start.ts` with `isAwaitingUser`.
  - `ChatCanvas` renders `<ElicitationCard>` under a message's `actionCard`, with `agentName`. `ChatCanvas`'s "has content" check includes `msg.elicitation`.
  - `App.tsx` routes the new popout actions, and `PopoutApp` sends them.
  - Keep `useAcpEngine.ts` under 500 lines by putting the answer logic in `elicitation-actions.ts`.

- [ ] **Step 5: Docs**

  - `CHANGELOG.md` under `Unreleased`: `- Agents can ask you for input in a form, or send you to a web page to sign in (ACP elicitation).`
  - `CLAUDE.md` Architecture gets an **Elicitation** paragraph:
    - `acp/elicitation/` parses, checks URLs and validates;
    - `manager/elicitation_routes.rs` routes, answers and cancels;
    - the UI sends only `sessionId`, `key`, `action` and `content`;
    - typed values are never stored or logged;
    - requests during `start`/`load` show in the opening session, and unrouted agents answer `cancel`.
  - `README.md` privacy section: an agent's sign-in page opens in your default browser; Zorvo makes no request for it.

- [ ] **Step 6: Full verification**

  Run: `pnpm lint && pnpm test && pnpm build && (cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)`
  Expected: everything passes.

- [ ] **Step 7: Commit**

  ```bash
  git add src/hooks/session-engine/elicitation-actions.ts src/hooks/useAcpSessions.ts src/hooks/session-engine/useAcpEngine.ts src/components/ChatCanvas.tsx src/components/PopoutApp.tsx src/lib/popout-bridge.ts src/App.tsx src/lib/session-start.ts src/test/setup.ts src/test/use-acp-elicitation.test.tsx src/test/popout.test.tsx CHANGELOG.md CLAUDE.md README.md
  git commit -m "feat: answer agent elicitations from the chat and popouts"
  ```
