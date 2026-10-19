# ACP Registry and Agent Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zorvo lists every agent in the official ACP registry, offers each one's newest version that has been listed for 7 days, detects agents already installed on the Mac, and keeps the list of agents the user uses.

**Architecture:** A new Rust module `src-tauri/src/registry/` parses, dates, fetches and resolves registry entries into the existing `AgentProfile` type; `get_agent_profiles` and `launch_for` read from it, so the webview still only names an agent id. The frontend migrates legacy ids, records the agents in use and their versions in `settings`, and shows only those.

**Tech Stack:** Rust (Tauri 2, serde, `ureq` with rustls), TypeScript/React 19, Vitest, a Node `.mjs` script.

**Spec:** `docs/superpowers/specs/2026-10-19-acp-registry-catalog-design.md`

## Global Constraints

- Registry URL, the only one fetched: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`.
- Fetch timeout 10 s; response cap 5 MB (5 * 1024 * 1024 bytes); redirects refused.
- Minimum age before a version is offered: 7 days (604 800 s).
- Background refetch when the last successful fetch is older than 24 h.
- Legacy ids: `claude-code` → `claude-acp`, `codex` → `codex-acp`, `qwen` → `qwen-code`.
- Default enabled agents: `claude-acp`, `codex-acp`, `qwen-code`.
- Entry id pattern: `^[a-z0-9][a-z0-9-]*$`.
- The webview CSP (`src-tauri/tauri.conf.json`) does not change; no network access from the webview.
- The webview never sends a program or arguments; only an agent id.
- `ensure_known_workspace` still guards every UI path.
- Test-first; `pnpm lint`, `pnpm test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` green before each commit.
- Source files under 800 lines. Commits in Conventional Commits form; stage explicit paths, never `git add -A`.

## Review Focus

- **First run, offline, bundle only:** Claude Agent, Codex and Qwen Code must be offered straight away; a bundle whose dates are all "today" would hide them for a week. Pinned by Task 5's bundled-history test.
- **An agent the user already uses gets a newer registry version:** its version must not change on its own (spec: "installed agents change version only when the user clicks Update"). Pinned by Task 6's `launches_the_recorded_version_not_the_newer_offered_one` and Task 8's recording of `agentVersions`.
- **Saved state with both old and new ids** (for example `agentOptions.qwen` and `agentOptions["qwen-code"]`): the new key wins, nothing crashes. Pinned by Task 7's migration test.
- **`npm` missing or slow:** `get_agent_profiles` must still answer; global-package detection is skipped after 5 s. Pinned by Task 6's `npm_globals_missing_npm_is_empty`.
- **Offline start:** no error banner and the bundled/cached catalog is used. Pinned by Task 4's fetch-failure tests and Task 6's `falls_back_to_the_bundle_without_a_cache`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/registry/mod.rs` | `Catalog`: bundle + cache load, refresh, profiles, launch resolution |
| `src-tauri/src/registry/schema.rs` | Typed registry entries, strict parsing, platform key |
| `src-tauri/src/registry/history.rs` | Dated version history, merge, offered version |
| `src-tauri/src/registry/fetch.rs` | HTTPS fetch with timeout, size cap, no redirects |
| `src-tauri/src/registry/resolve.rs` | Entry → `AgentProfile`; availability; legacy ids |
| `src-tauri/src/registry/npm_globals.rs` | Global npm package names via `npm ls -g` |
| `src-tauri/resources/registry-history.json` | Bundled history (generated, committed) |
| `scripts/registry-history.mjs` | Pure merge logic for the bundled history |
| `scripts/registry-update.mjs` | `pnpm registry:update` entry point |
| `src-tauri/src/profiles.rs` | New `AgentProfile` fields; hard-coded ACP profiles removed |
| `src-tauri/src/acp/commands.rs` | `launch_for` through the catalog |
| `src-tauri/src/lib.rs` | Catalog state, startup refresh, `agent-profiles-changed` event |
| `src-tauri/src/store.rs` | `Settings` gains `enabled_agents`, `removed_agents`, `agent_versions` |
| `src/types/index.ts` | Matching TS fields |
| `src/lib/persistence.ts` | Legacy id migration, new settings fields |
| `src/lib/enabled-agents.ts` | Which agents are in use; auto-enable; version recording |
| `src/hooks/useDiscovery.ts` | Reload on `agent-profiles-changed` |
| `src/components/Sidebar.tsx`, `src/components/onboarding/AgentsStep.tsx`, `src/components/onboarding/DefaultAgentStep.tsx`, `src/lib/agent-readiness.ts` | Show only agents in use |
| `src/components/AgentLogo.tsx` | Logos keyed by new ids |
| `README.md`, `site/` privacy section | Privacy text |

---

### Task 1: Registry schema

**Files:**
- Create: `src-tauri/src/registry/mod.rs` (module declarations only for now), `src-tauri/src/registry/schema.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod registry;`)
- Test: `src-tauri/tests/registry_schema_test.rs`

**Interfaces:**
- Produces:
  ```rust
  pub struct RegistryEntry { pub id: String, pub name: String, pub version: String,
      pub description: Option<String>, pub icon: Option<String>, pub distribution: Distribution }
  pub enum Distribution {
      Npx { package: String, args: Vec<String> },
      Uvx { package: String, args: Vec<String> },
      Binary { platforms: BTreeMap<String, BinaryTarget> },
  }
  pub struct BinaryTarget { pub archive: String, pub cmd: String, pub args: Vec<String>, pub sha256: String }
  pub fn parse_registry(json: &str) -> Result<Vec<RegistryEntry>, String>;
  pub fn current_platform() -> &'static str; // "darwin-aarch64" | "darwin-x86_64" | …
  ```
  All types derive `Debug, Clone, PartialEq, Serialize, Deserialize`; `RegistryEntry` serializes back to the registry's own JSON shape (it is stored in the history).

- [ ] **Step 1: Write the failing tests** in `registry_schema_test.rs`, with an inline registry JSON holding one valid `npx`, one valid `uvx`, one valid `binary` entry and one entry per invalid rule:
  - `parses_valid_npx_uvx_and_binary_entries` — the three valid ids come back with their package/args, archive/cmd/sha256.
  - `skips_an_entry_whose_id_breaks_the_pattern` — id `"Bad_Id"` absent, others present.
  - `skips_an_unpinned_package` — `"@x/y"` and `"y@latest"` skipped; `"@x/y@1.2.3"` and `"y@0.0.34"` kept.
  - `skips_a_binary_without_https_or_a_64_hex_sha256` — `http://` archive and `sha256: "abc"` skipped.
  - `skips_a_cmd_that_is_absolute_or_climbs` — `"/bin/sh"` and `"../x"` skipped.
  - `skips_an_entry_with_no_or_two_distributions`.
  - `rejects_a_document_without_agents` — `parse_registry("{}")` is `Err`; `parse_registry("not json")` is `Err`.

- [ ] **Step 2: Run** `cd src-tauri && cargo test --test registry_schema_test` — expect compile failure (no module).

- [ ] **Step 3: Implement `schema.rs`.** Deserialize into `serde_json::Value` first, then validate each element of `agents` on its own so one bad entry never fails the rest. Pinned package: the part after the last `@` (ignoring a leading scope `@`) must match `^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$`. `current_platform()` uses `std::env::consts::{OS, ARCH}` mapped to `macos→darwin`, `aarch64`, `x86_64`.

- [ ] **Step 4: Run** the test file — all pass. Run `cargo clippy --all-targets -- -D warnings`.

- [ ] **Step 5: Commit** — `git add src-tauri/src/lib.rs src-tauri/src/registry/mod.rs src-tauri/src/registry/schema.rs src-tauri/tests/registry_schema_test.rs` — `feat: parse the ACP registry strictly`.

### Task 2: Version history

**Files:**
- Create: `src-tauri/src/registry/history.rs`
- Test: `src-tauri/tests/registry_history_test.rs`

**Interfaces:**
- Consumes: `RegistryEntry` (Task 1).
- Produces:
  ```rust
  pub const MIN_AGE_SECS: u64 = 7 * 24 * 60 * 60;
  #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
  pub struct VersionHistory { pub agents: BTreeMap<String, BTreeMap<String, HistoryRecord>> }
  #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
  pub struct HistoryRecord { pub first_seen: u64 /* unix secs */, pub entry: RegistryEntry }
  impl VersionHistory {
      pub fn from_json(json: &str) -> Result<Self, String>;
      pub fn to_json(&self) -> String;
      /// Adds each entry's (id, version) first seen at `now`; never changes an existing date.
      pub fn observe(&mut self, entries: &[RegistryEntry], now: u64) -> bool /* changed */;
      /// Earliest date wins for a version both histories know.
      pub fn merge(&mut self, other: &VersionHistory);
      /// Newest version (semver order) first seen at least MIN_AGE_SECS before `now`.
      pub fn offered(&self, id: &str, now: u64) -> Option<&RegistryEntry>;
      pub fn version(&self, id: &str, version: &str) -> Option<&RegistryEntry>;
      pub fn ids(&self) -> impl Iterator<Item = &str>;
  }
  ```

- [ ] **Step 1: Write the failing tests:**
  - `offers_the_newest_version_past_seven_days` — v1 seen at 0, v2 at 100: `offered(id, MIN_AGE_SECS + 100)` is v2; at `MIN_AGE_SECS + 99` it is v1.
  - `offers_nothing_before_seven_days` — only v1 at 0: `offered(id, MIN_AGE_SECS - 1)` is `None`, at `MIN_AGE_SECS` is `Some`.
  - `observe_never_moves_an_existing_date` — observe v1 at 10, again at 20: `first_seen == 10`; return `false` the second time.
  - `merge_keeps_the_earlier_date`.
  - `orders_versions_by_semver_not_text` — `0.10.0` beats `0.9.9`.
  - `round_trips_through_json`.

- [ ] **Step 2: Run** `cargo test --test registry_history_test` — fails to compile.

- [ ] **Step 3: Implement `history.rs`.** Compare versions by splitting the core `x.y.z` into numbers (pre-release sorts below its release); no new crate.

- [ ] **Step 4: Run** the tests — pass; clippy clean.

- [ ] **Step 5: Commit** — `feat: keep a dated history of registry versions`.

### Task 3: Profiles from registry entries

**Files:**
- Create: `src-tauri/src/registry/resolve.rs`
- Modify: `src-tauri/src/profiles.rs` (new fields on `AgentProfile`, `AgentProfile::new` defaults), `src/types/index.ts` (`AgentProfile`)
- Test: `src-tauri/tests/registry_resolve_test.rs`

**Interfaces:**
- Consumes: `RegistryEntry`, `Distribution`, `current_platform` (Task 1).
- Produces:
  - New `AgentProfile` fields (Rust `snake_case`, serialized as is, like the existing ones):
    `source: String` (`"registry"`/`"builtin"`), `version: Option<String>`, `distribution: Option<String>` (`"npx"|"uvx"|"binary"`), `availability: String` (`"ready"|"needs_runtime"|"not_installed"`), `description: Option<String>`, `installed_on_system: bool`, `listed: bool`. Defaults in `AgentProfile::new`: `"builtin"`, `None`, `None`, `"ready"`, `None`, `false`, `true`.
  - TS `AgentProfile` gains the same fields; `export type AgentAvailability = 'ready' | 'needs_runtime' | 'not_installed';`.
  - ```rust
    pub const LEGACY_IDS: [(&str, &str); 3] = [("claude-code","claude-acp"),("codex","codex-acp"),("qwen","qwen-code")];
    pub fn canonical_agent_id(id: &str) -> &str;
    pub struct SystemTools<'a> { pub path_var: Option<&'a str>, pub npm_globals: &'a BTreeSet<String> }
    pub fn resolve_profile(entry: &RegistryEntry, tools: &SystemTools, listed: bool) -> AgentProfile;
    /// Why a profile cannot run, for the launch error; None when it is ready.
    pub fn missing_reason(profile: &AgentProfile) -> Option<String>;
    ```
  `resolve_profile` sets `transport = "acp"`, `command` to the program name (`npx`, `uvx`, or the binary `cmd` basename), `acp_program`/`acp_args` to what runs (`npx`: `["-y", package, args…]`; `uvx`: `[package, args…]`; binary: the `cmd` basename and its `args`), `acp_program_path` from `find_binary_in_path_str`, `detected = availability == "ready"`, `detected_path = acp_program_path`, `installed_on_system` = binary `cmd` on `PATH`, or the `npx` package name (without version) in `npm_globals`.

- [ ] **Step 1: Write the failing tests** (build a temp dir with an executable `npx`/`uvx`/`opencode` file and pass it as `path_var`):
  - `npx_entry_runs_the_pinned_package_through_npx` — `acp_args == ["-y","@google/gemini-cli@0.64.0","--acp"]`, `availability == "ready"`, `distribution == Some("npx")`.
  - `npx_entry_without_npx_needs_a_runtime` — empty PATH → `"needs_runtime"`, `detected == false`.
  - `binary_entry_on_path_is_ready_and_installed_on_system`.
  - `binary_entry_missing_is_not_installed`.
  - `npx_package_installed_globally_is_installed_on_system` — `npm_globals` contains `"@google/gemini-cli"`.
  - `maps_legacy_ids` — the three pairs, and an unknown id returned unchanged.
  - `missing_reason_names_what_is_missing` — `needs_runtime` npx profile: `"Gemini CLI needs Node.js (npx), which was not found"`; `not_installed` binary: `"OpenCode is not installed (opencode was not found on PATH)"`; a ready profile: `None`.

- [ ] **Step 2: Run** `cargo test --test registry_resolve_test` — fails.

- [ ] **Step 3: Implement** the fields (update every `AgentProfile` construction and the TS fixture `src/test/fixtures/agents.ts` with the defaults) and `resolve.rs`.

- [ ] **Step 4: Run** `cargo test` (all Rust) and `pnpm lint` — pass.

- [ ] **Step 5: Commit** — `feat: resolve registry entries into agent profiles`.

### Task 4: Registry fetch

**Files:**
- Create: `src-tauri/src/registry/fetch.rs`
- Modify: `src-tauri/Cargo.toml` (`ureq = { version = "=<latest 3.x released ≥ 7 days ago>", default-features = false, features = ["rustls"] }`; pin exactly and note the version in the commit)
- Test: `src-tauri/tests/registry_fetch_test.rs`

**Interfaces:**
- Produces:
  ```rust
  pub const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
  pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
  pub const MAX_REGISTRY_BYTES: u64 = 5 * 1024 * 1024;
  pub fn fetch_registry(url: &str, timeout: Duration, max_bytes: u64) -> Result<String, String>;
  ```
  No redirects followed (`max_redirects(0)`); a 3xx is an error.

- [ ] **Step 1: Write the failing tests** against a `std::net::TcpListener` on `127.0.0.1:0` that answers one canned HTTP response per test (helper in the test file):
  - `returns_the_body_of_a_200`.
  - `fails_on_a_server_error` — 500 → `Err`.
  - `fails_after_the_timeout` — server accepts and never answers; timeout 300 ms → `Err` within 2 s.
  - `fails_on_a_body_over_the_cap` — `max_bytes = 10`, body of 11 bytes → `Err`.
  - `refuses_a_redirect` — 302 with `Location` to another port → `Err`, and the second server receives no request.

- [ ] **Step 2: Run** `cargo test --test registry_fetch_test` — fails.

- [ ] **Step 3: Implement** with a `ureq::Agent` built from config: global timeout, `max_redirects(0)`, `http_status_as_error(true)`; read the body with a limit of `max_bytes + 1` and error if it reaches it.

- [ ] **Step 4: Run** the tests, `cargo clippy`, and `cargo audit` if installed — pass.

- [ ] **Step 5: Commit** — `git add src-tauri/Cargo.toml src-tauri/Cargo.lock …` — `feat: fetch the ACP registry with a timeout and size cap`.

### Task 5: Bundled history and `pnpm registry:update`

**Files:**
- Create: `scripts/registry-history.mjs`, `scripts/registry-update.mjs`, `scripts/registry-history.test.mjs`, `src-tauri/resources/registry-history.json`
- Modify: `package.json` (`"registry:update": "node scripts/registry-update.mjs"`)
- Test: `scripts/registry-history.test.mjs`, plus `bundled_history_offers_the_default_agents` in `src-tauri/tests/registry_history_test.rs`

**Interfaces:**
- Consumes: the JSON shape of `VersionHistory` (Task 2): `{ "agents": { "<id>": { "<version>": { "first_seen": <unix secs>, "entry": <registry entry> } } } }`.
- Produces: `export function mergeObserved(history, entries, now, publishedAt)` in `registry-history.mjs` — returns a new history object; a version already present keeps its `first_seen`; a new version gets `min(now, publishedAt(entry) ?? now)`.
  `registry-update.mjs` fetches `REGISTRY_URL`, looks up each new version's publish time (`npm view <package> time --json` for `npx`/`uvx` packages; the GitHub release `published_at` via `gh api repos/<owner>/<repo>/releases/tags/v<version>` for binaries, skipped when unavailable), and writes the file sorted by id and version with 2-space indentation.

- [ ] **Step 1: Write the failing tests:**
  - `scripts/registry-history.test.mjs` (import `describe/it/expect` from `vitest`): `keeps an existing date`, `dates a new version by its publish time when that is earlier`, `dates a version without a publish time today`, `does not mutate its input`.
  - Rust `bundled_history_offers_the_default_agents`: `VersionHistory::from_json(include_str!("../resources/registry-history.json"))`, `offered(id, generated_at)` is `Some` for `claude-acp`, `codex-acp`, `qwen-code`, where `generated_at` is the newest `first_seen` in the file.

- [ ] **Step 2: Run** `pnpm vitest run scripts/registry-history.test.mjs` and the Rust test — fail.

- [ ] **Step 3: Implement** the two scripts, then run `pnpm registry:update` to produce `src-tauri/resources/registry-history.json`.

- [ ] **Step 4: Run** both tests — pass. If the Rust test fails because a default agent's only version is under 7 days old, add that agent's previous version from its package history with its publish date (`npm view <package>@<prev> time`) — the script's `--include <package@version>` flag — and rerun.

- [ ] **Step 5: Commit** — `feat: bundle a dated registry history with pnpm registry:update`.

### Task 6: Catalog in the backend

**Files:**
- Create: `src-tauri/src/registry/npm_globals.rs`
- Modify: `src-tauri/src/registry/mod.rs`, `src-tauri/src/profiles.rs` (drop `claude_code_profile`, `codex_profile`, `qwen_profile`, `CLAUDE_ACP_ADAPTER`, `CODEX_ACP_ADAPTER`; `get_available_agent_profiles` merges the catalog), `src-tauri/src/acp/commands.rs` (`launch_for`), `src-tauri/src/lib.rs`, `src-tauri/src/store.rs` (`Settings`)
- Test: `src-tauri/tests/registry_catalog_test.rs`, `src-tauri/tests/store_test.rs`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  ```rust
  // store.rs Settings, all #[serde(default)], camelCase on the wire:
  pub enabled_agents: Option<Vec<String>>,   // None = never set
  pub removed_agents: Vec<String>,
  pub agent_versions: BTreeMap<String, String>, // agent id -> version in use
  // registry/npm_globals.rs
  pub fn npm_globals(env: &HashMap<String, String>, timeout: Duration) -> BTreeSet<String>;
  // registry/mod.rs
  pub struct Catalog { /* bundle + local history, last_fetch: Option<u64>, data_dir */ }
  impl Catalog {
      pub fn open(data_dir: PathBuf, bundled_json: &str) -> Self;     // loads registry-history.json + registry-cache.json from data_dir
      pub fn needs_refresh(&self, now: u64) -> bool;                  // last_fetch older than 24 h or none
      pub fn refresh(&self, fetch: impl Fn() -> Result<String, String>, now: u64) -> Result<bool, String>; // observe + persist; true when changed
      pub fn profiles(&self, tools: &SystemTools, versions: &BTreeMap<String, String>, now: u64) -> Vec<AgentProfile>;
      pub fn last_fetch(&self) -> Option<u64>;
  }
  pub const AGENT_PROFILES_CHANGED: &str = "agent-profiles-changed";
  ```
  `profiles` returns one profile per id in the history: the version in `versions` when that version is in the history, else `offered(id, now)`; ids with neither are left out; `listed` is false for ids absent from the latest fetched registry. `launch_for(profile_id)` maps the id with `canonical_agent_id`, reads `agent_versions` from `AppStore`, uses the catalog's profile for it, and fails with `missing_reason` when it is not ready.
  `last_fetch` is exposed for the "registry last updated" line, whose UI is part of sub-project 4 (the Agents page); this plan adds no Settings UI.
  `lib.rs` manages `Catalog` (`Arc`), spawns a background refresh after setup when `needs_refresh`, and emits `AGENT_PROFILES_CHANGED` when it returns `Ok(true)`. `get_agent_profiles(refresh: true)` refreshes synchronously (it is already `async`).

- [ ] **Step 1: Write the failing tests:**
  - `registry_catalog_test.rs`: `falls_back_to_the_bundle_without_a_cache` (empty temp data dir, `profiles` lists the bundle's ids); `refresh_records_new_versions_and_persists_them` (fake fetch returning a one-entry registry; reopen the catalog from the same dir and the version is there); `a_failed_refresh_keeps_the_cache` (fetch returns `Err`, profiles unchanged, `last_fetch` unchanged); `launches_the_recorded_version_not_the_newer_offered_one` (history with v1 and v2 both past 7 days, `versions = {id: v1}` → profile `version == Some(v1)` and `acp_args` contain `@v1`); `lists_an_agent_dropped_from_the_registry_as_unlisted`; `needs_refresh_after_24_hours`.
  - `npm_globals_missing_npm_is_empty` — env with empty `PATH` returns an empty set without blocking past the timeout.
  - `store_test.rs`: `settings_keep_enabled_removed_and_versioned_agents` — round-trip of the three new fields; a file without them loads with `None`, `[]`, `{}`.

- [ ] **Step 2: Run** `cargo test` — the new tests fail.

- [ ] **Step 3: Implement.** Cache file `registry-cache.json` in the app data dir holds `{ "last_fetch": <secs>, "listed": [ids] }`; local history file `registry-history.json` beside it; write both atomically like `store.rs` does. `npm_globals` runs `npm ls -g --depth=0 --json` with the user env, kills it after the timeout (5 s), and returns the keys of `dependencies`. Update the existing tests that build Claude/Codex/Qwen profiles (`profiles_test.rs`, `spawn_plan_test.rs`) to the terminal profiles only.

- [ ] **Step 4: Run** `cargo test`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` — pass.

- [ ] **Step 5: Commit** — `feat: serve agent profiles from the ACP registry catalog`.

### Task 7: Frontend types and legacy id migration

**Files:**
- Modify: `src/types/index.ts` (`Settings`), `src/lib/persistence.ts`, `src/components/AgentLogo.tsx`
- Test: `src/test/persistence.test.ts`

**Interfaces:**
- Produces:
  - `Settings` gains `enabledAgents?: string[]; removedAgents?: string[]; agentVersions?: Record<string, string>;`.
  - `export const LEGACY_AGENT_IDS: Readonly<Record<string, string>>` and `export function canonicalAgentId(id: string): string` in `src/lib/persistence.ts`.
  - `normalizePersistedState` returns state with every `session.profileId`, `settings.defaultAgentId`, and `agentOptions` key canonical; when both an old and a new `agentOptions` key exist, the new key's value is kept.
  - `AgentLogo` `LOGOS` keyed `claude-acp`, `qwen-code`, `codex-acp`, and looked up through `canonicalAgentId(profileId)`.

- [ ] **Step 1: Write the failing tests** in `persistence.test.ts`: `rewrites legacy agent ids in sessions and the default agent`; `moves legacy agentOptions keys, keeping the new key when both exist`; `keeps the new settings fields and defaults them when missing`.

- [ ] **Step 2: Run** `pnpm vitest run src/test/persistence.test.ts` — fail.

- [ ] **Step 3: Implement.** Update fixtures and existing tests that use `claude-code`/`qwen`/`codex` ids only where a test asserts on a profile id coming from the backend; persisted-state fixtures keep old ids to exercise the migration.

- [ ] **Step 4: Run** `pnpm lint && pnpm test` — pass.

- [ ] **Step 5: Commit** — `feat: migrate saved agent ids to their registry ids`.

### Task 8: Agents in use

**Files:**
- Create: `src/lib/enabled-agents.ts`
- Modify: `src/App.tsx` (apply `withAutoEnabled` when profiles load), `src/hooks/useDiscovery.ts` (reload on `agent-profiles-changed`), `src/components/Sidebar.tsx`, `src/components/onboarding/AgentsStep.tsx`, `src/components/onboarding/DefaultAgentStep.tsx`, `src/lib/agent-readiness.ts`
- Test: `src/test/enabled-agents.test.ts`, `src/test/chrome-wiring.test.tsx` (sidebar), `src/test/onboarding.test.tsx`

**Interfaces:**
- Consumes: `AgentProfile` fields (Task 3), `Settings` fields (Task 7).
- Produces:
  ```ts
  export const DEFAULT_ENABLED_AGENTS: readonly string[] = ['claude-acp', 'codex-acp', 'qwen-code'];
  export function enabledAgentIds(settings: Settings): readonly string[]; // settings.enabledAgents ?? DEFAULT_ENABLED_AGENTS
  export function isInUse(agent: AgentProfile, settings: Settings): boolean; // builtin: agent.detected; registry: enabled
  export function withAutoEnabled(settings: Settings, agents: readonly AgentProfile[]): Settings;
  ```
  `withAutoEnabled` returns the same object when nothing changes; otherwise a new `Settings` where each registry agent with `installed_on_system` and not in `removedAgents` is added to `enabledAgents`, and every enabled registry agent with a `version` but no `agentVersions` entry gets one.

- [ ] **Step 1: Write the failing tests:**
  - `enabled-agents.test.ts`: `uses the defaults until the user changes the list`; `enables an agent found installed on the system once`; `does not re-enable an agent the user removed`; `records the version of each agent in use`; `returns the same settings when nothing changes`; `a builtin terminal agent is in use when detected`.
  - Sidebar: `lists only the agents in use` — profiles include a ready registry agent not enabled (absent) and an enabled one (present).
  - Onboarding: the agents step lists only agents in use.
  - `useDiscovery`: an `agent-profiles-changed` event triggers `get_agent_profiles` again.

- [ ] **Step 2: Run** those test files — fail.

- [ ] **Step 3: Implement** and wire: `App.tsx` calls `updateState(prev => ({ ...prev, settings: withAutoEnabled(prev.settings, agents) }))` when `agents` changes (no-op when unchanged); `DetectedAgents` and onboarding filter with `isInUse`; `resolveDefaultAgentId` only picks agents in use.

- [ ] **Step 4: Run** `pnpm lint && pnpm test` — pass.

- [ ] **Step 5: Commit** — `feat: keep the agents in use and enable installed ones`.

### Task 9: Privacy text, changelog, docs

**Files:**
- Modify: `README.md` (*Privacy and your data*, *Supported agents*, *How it works*), the landing page's privacy copy under `site/` (find it with `git grep -n "network" site/`), `CHANGELOG.md` (`Unreleased`), `CLAUDE.md` (agent profiles paragraph)
- Test: `src/test/site.test.tsx` if it asserts privacy copy

- [ ] **Step 1: Write** the README privacy bullet replacing "No traffic of its own": Zorvo itself contacts only the ACP registry (`cdn.agentclientprotocol.com`) to list agents and their versions, and the download addresses the registry lists, `nodejs.org` and `uv`'s releases when it installs an agent or runtime, each download checked against its published hash; no telemetry, and the window itself makes no network requests. Mirror it on the landing page.

- [ ] **Step 2: Add** `CHANGELOG.md` `Unreleased` lines: *Added* — every agent in the ACP registry, agents already installed show up on their own, new versions offered after a week; *Changed* — Claude Code, Codex and Qwen Code now come from the ACP registry.

- [ ] **Step 3: Update** `CLAUDE.md`: agent profiles come from `src-tauri/src/registry/` (registry, dated history, 7-day wait) plus the terminal profiles in `profiles.rs`; `pnpm registry:update` refreshes the bundled history.

- [ ] **Step 4: Run** `pnpm lint && pnpm test`, then the manual check: `pnpm tauri build --debug --bundles app`, open it, and confirm an agent already installed on the Mac (Gemini CLI or OpenCode) appears in the sidebar.

- [ ] **Step 5: Commit** — `docs: describe registry agents and the hosts Zorvo contacts`.
