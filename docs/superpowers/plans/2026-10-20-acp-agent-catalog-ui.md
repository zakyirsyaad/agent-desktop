# ACP Agent Catalog UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Settings → Agents catalog of every ACP registry agent, with search, registry logos, statuses, and Add, Update and Remove.

**Architecture:** The Rust backend gains a catalog read model (`get_agent_catalog`), an `update_agent` command and a registry icon cache (`get_agent_icons`); `get_agent_profiles` stays the runtime contract. The React frontend renders the catalog in a tabbed Settings dialog and onboarding, reuses the installer's module-level install store for Add and Update, and shows a badge plus a once-per-version notice for updates.

**Tech Stack:** Tauri 2, Rust (serde, ureq, base64), React 19, Tailwind 4, Vitest + Testing Library, pnpm.

**Spec:** `docs/superpowers/specs/2026-10-20-acp-agent-catalog-ui-design.md`

## Global Constraints

- The webview sends only an agent id; the backend rebuilds versions, plans and downloads from the registry. Never let the UI pass a version, command or URL.
- New commands touching the filesystem, network or a child process are `#[tauri::command(async)]`, registered in `lib.rs`'s `generate_handler!`, and faked in `src/test/setup.ts`.
- The webview makes no network requests; `tauri.conf.json`'s CSP does not change.
- The main window is the single writer of `state.json`; the backend never writes settings.
- Versions change only through **Update** (`update_agent`).
- A version is offered only when first seen ≥ 7 days ago (`MIN_AGE_SECS`) and not withdrawn.
- Icons: only URLs starting `https://cdn.agentclientprotocol.com/`, 64 KB cap (`64 * 1024`), 10-second timeout, body must start with `<svg` after an optional XML prolog and whitespace.
- Design system: tokens only (no raw colors), `ui/` primitives (`Button`, `IconButton`), `focus-ring` on every focusable control, sentence-case copy that names agents and says "you".
- Source files under 800 lines; `App.tsx` (815 lines now) must not grow — new logic goes into hooks, `lib/` helpers and components.
- Conventional Commits; stage explicit paths only, never `git add -A`.
- Rust commands run from `src-tauri/` and need `dist/` (run `pnpm build` once first).
- Copy is fixed by the spec; use these strings verbatim: "Installed by Zorvo", "Installed on your Mac", "Managed outside Zorvo", "Runs with npx", "Runs with uvx", "Not installed", "Not available for this Mac", "No longer listed", "Available from <date>", "Update to <version>", "No agents match "<query>".", "Registry checked <relative time>", "Could not load the agents: <error>", "Remove <Agent>? Zorvo deletes its copy. Saved sessions stay readable.", "Its open sessions stop.", "Could not delete Zorvo's copy: <error>", "Update failed: <error>", "<Agent> was removed. Add it again to continue this session.", "<Agent> <version> is available.", "<n> agent updates are available.", "<Agent> is not available for this Mac", "No newer version of <Agent> is offered", "<Agent> is managed outside Zorvo".

## Review Focus

1. **Remove while the agent's install is still running in the row** — the backend stops the job; the row must end on Add, not stuck on a progress bar. Test in Task 9.
2. **Update pressed twice, or Update while an install of the same agent runs** — only one job starts; the second press is ignored. Test in Task 8.
3. **An in-use version the registry withdrew** — the agent already runs the offered version, so `updateVersion` must be `null`, not an "update" to the version it runs. Test in Task 3.
4. **A corrupt icon cache (`index.json` not JSON, an `.svg` file that is not SVG)** — treated as no cache: refetch, and never hand a non-SVG data URL to the UI. Test in Task 5.
5. **Removing the default agent** — `defaultAgentId` is cleared so new sessions fall back to another agent instead of a disabled one. Test in Task 6.

---

### Task 1: Keep catalog-only entries and the `unsupported` availability

**Files:**
- Modify: `src-tauri/src/registry/schema.rs` (`is_valid_entry`, binary arm)
- Modify: `src-tauri/src/registry/resolve.rs` (constants, `Resolution::availability`, new `is_supported`)
- Modify: `src-tauri/src/registry/mod.rs` (`CatalogState::profile`, new `Catalog::unsupported_agent_name`)
- Modify: `src-tauri/src/acp/commands.rs` (`launch_for`)
- Test: `src-tauri/tests/registry_schema_test.rs`, `src-tauri/tests/registry_resolve_test.rs`, `src-tauri/tests/registry_catalog_test.rs`

**Interfaces:**
- Produces: `pub const AVAILABILITY_UNSUPPORTED: &str = "unsupported";`, `pub fn is_supported(entry: &RegistryEntry) -> bool` (false only for a binary entry without `current_platform()`'s target), `Catalog::unsupported_agent_name(&self, id: &str, versions: &BTreeMap<String, String>, now: u64) -> Option<String>`.

- [ ] **Step 1: Write the failing tests**
  - schema: `binary_entry_without_this_macs_target_is_kept` — an entry whose only platform is `linux-x86_64` parses; `binary_entry_with_a_broken_target_for_this_mac_is_dropped` — this Mac's target with an `http://` archive is skipped.
  - resolve: `binary_entry_without_this_macs_target_is_unsupported` — `resolve_profile(...).availability == "unsupported"`, `install_plan == None`.
  - catalog: `unsupported_agents_are_not_profiles` — `catalog.profiles(..)` leaves the id out and `catalog.profile(id, ..)` is `None`; `unsupported_agent_name` returns `Some(name)`; a supported or unknown id gives `None`.
  - acp: in `acp/commands.rs` tests, `launch_for` on an unsupported id errors with exactly `"<Agent name> is not available for this Mac"`.

- [ ] **Step 2: Run them and see them fail**

Run: `cargo test --test registry_schema_test --test registry_resolve_test --test registry_catalog_test && cargo test --lib acp::commands`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement**
  - schema: for `Binary`, require `is_exact_version` and, when `platforms.get(current_platform())` is `Some`, a valid, safe target; `None` is valid.
  - resolve: `availability()` returns `AVAILABILITY_UNSUPPORTED` when the entry is binary and `target` is `None` (check before `NotInstalled`); `install_plan` is `None` for it.
  - mod.rs: `CatalogState::profile` returns `None` when `!is_supported(entry)`; `planned_steps_for` and `agent_name` keep working as they do (they plan nothing for it).
  - acp: when the profile lookup is `None`, return the unsupported message when `unsupported_agent_name` is `Some`, else the existing unknown-agent error.

- [ ] **Step 4: Run the tests and see them pass** (same command). Expected: PASS, and `cargo test` overall still green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/registry/schema.rs src-tauri/src/registry/resolve.rs src-tauri/src/registry/mod.rs src-tauri/src/acp/commands.rs src-tauri/tests/registry_schema_test.rs src-tauri/tests/registry_resolve_test.rs src-tauri/tests/registry_catalog_test.rs
git commit -m "feat: keep registry agents not built for this Mac as unsupported"
```

### Task 2: A recorded version must be old enough

**Files:**
- Modify: `src-tauri/src/registry/history.rs` (new `first_seen`)
- Modify: `src-tauri/src/registry/mod.rs` (`CatalogState::entry_for`)
- Test: `src-tauri/tests/registry_catalog_test.rs`, `src-tauri/tests/registry_history_test.rs`

**Interfaces:**
- Produces: `VersionHistory::first_seen(&self, id: &str, version: &str) -> Option<u64>`; private `CatalogState::is_old_enough(&self, id, version, now) -> bool` (`now.saturating_sub(first_seen) >= MIN_AGE_SECS`).

- [ ] **Step 1: Write the failing tests**
  - `a_recorded_version_first_seen_6_days_ago_is_not_used` — history: `1.0.0` at T0, `1.1.0` at T0+10d; `agentVersions = {id: "1.1.0"}`; at now = T0+16d (1.1.0 is 6 days old) the profile's `version == "1.0.0"`.
  - `a_recorded_version_first_seen_7_days_ago_is_used` — same at now = T0+17d gives `"1.1.0"`.
  - history: `first_seen_returns_the_date_or_none`.

- [ ] **Step 2: Run and see them fail.** Run: `cargo test --test registry_catalog_test --test registry_history_test`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `entry_for`, a recorded version that is not old enough is treated as not recorded (falls through to `self.offered(id, now)`); the withdrawn branch is unchanged. `entry_for` gains the `now` it already receives.

- [ ] **Step 4: Run and see them pass.** Same command, plus `cargo test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/registry/history.rs src-tauri/src/registry/mod.rs src-tauri/tests/registry_catalog_test.rs src-tauri/tests/registry_history_test.rs
git commit -m "fix: ignore a recorded agent version younger than seven days"
```

### Task 3: Catalog read model and `get_agent_catalog`

**Files:**
- Modify: `src-tauri/src/registry/resolve.rs` (new `InstallStatus`, `install_status`)
- Modify: `src-tauri/src/registry/history.rs` (new `records`)
- Create: `src-tauri/src/registry/catalog_view.rs`
- Modify: `src-tauri/src/registry/mod.rs` (`pub mod catalog_view;`, `Catalog::catalog_view`, `Catalog::update_target`)
- Modify: `src-tauri/src/lib.rs` (command `get_agent_catalog`, register it)
- Test: `src-tauri/tests/registry_catalog_view_test.rs` (new)

**Interfaces:**
- Consumes: Task 1 `is_supported`, Task 2 `entry_for` rule.
- Produces:

```rust
// resolve.rs
pub enum InstallStatus { ByZorvo, OnYourMac { location: Option<String> }, Ready, NotInstalled, Unsupported }
pub fn install_status(entry: &RegistryEntry, tools: &SystemTools) -> InstallStatus;

// history.rs
pub fn records(&self, id: &str) -> impl Iterator<Item = (&str, &HistoryRecord)>;

// catalog_view.rs  (Serialize, camelCase)
pub struct CatalogAgent {
    pub id: String, pub name: String, pub description: Option<String>,
    pub distribution: String,          // "npx" | "uvx" | "binary"
    pub listed: bool,
    pub version: Option<String>,
    pub update_version: Option<String>,
    pub status: String,                // STATUS_* below
    pub available_from: Option<u64>,
    pub location: Option<String>,
}
pub struct AgentCatalog { pub last_checked: Option<u64>, pub agents: Vec<CatalogAgent> }
pub const STATUS_BY_ZORVO: &str = "by_zorvo";      // also STATUS_ON_YOUR_MAC "on_your_mac", STATUS_READY "ready",
                                                   // STATUS_NOT_INSTALLED "not_installed", STATUS_UNSUPPORTED "unsupported", STATUS_WAITING "waiting"

// mod.rs
impl Catalog {
    pub fn catalog_view(&self, tools: &SystemTools, versions: &BTreeMap<String, String>, now: u64) -> AgentCatalog;
    /// The entry Update moves to; Err with the spec's copy otherwise.
    pub fn update_target(&self, id: &str, tools: &SystemTools, versions: &BTreeMap<String, String>, now: u64) -> Result<RegistryEntry, String>;
}

// lib.rs
#[tauri::command(async)] fn get_agent_catalog(store: State<'_, AppStore>) -> Result<AgentCatalog, String>;
```

`install_status` order: binary without this Mac's target → `Unsupported`; availability not ready → `NotInstalled`; `installed_on_system` → `OnYourMac` (`location` = the found program path for binary, `None` for an npm global); `zorvo_runtime.is_some()` (npx/uvx on Zorvo's Node/uv) or a binary run from Zorvo's tools dir → `ByZorvo`; else `Ready`.

`catalog_view`: one `CatalogAgent` per `history.ids()`. With an entry from `entry_for` → its fields, `version = Some(entry.version)`, status from `install_status`. Without one → `STATUS_WAITING`, name and description from the newest record, `version = None`, `available_from = min(first_seen of non-withdrawn versions) + MIN_AGE_SECS`. `update_version` = `offered(id, now)`'s version when `compare_versions(offered, version) == Greater`, and `None` for `Unsupported`, `Waiting` and `OnYourMac { location: Some(_) }`. `last_checked = self.last_fetch()`. Sorted by id.

- [ ] **Step 1: Write the failing tests** in `registry_catalog_view_test.rs` (reuse the `bundle_of`/`npx_entry` style helpers from `registry_catalog_test.rs`):
  - `each_status_is_reported` — one agent per status: npx with the user's Node ≥ 22 (`ready`), npx with only Zorvo's Node (`by_zorvo`), npx with its package in `npm_globals` (`on_your_mac`, `location: None`), binary on `PATH` (`on_your_mac`, `location: Some(path)`), binary in `InstalledTools.agents` (`by_zorvo`), binary missing (`not_installed`), binary with only a `linux-x86_64` target (`unsupported`), only version first seen 2 days ago (`waiting`, `available_from == first_seen + MIN_AGE_SECS`, `version == None`).
  - `update_version_is_the_newer_offered_version` — recorded `1.0.0`, `1.1.0` 8 days old → `Some("1.1.0")`; `1.1.0` 3 days old → `None`.
  - `update_version_is_none_when_the_recorded_version_was_withdrawn` — recorded `1.1.0`, registry lists `1.0.0` (so `1.1.0` withdrawn) → `version == "1.0.0"`, `update_version == None`.
  - `update_version_is_none_for_a_binary_on_path`.
  - `update_target_refuses_with_the_spec_copy` — no newer: `Err("No newer version of Agent x is offered")`; binary on PATH: `Err("Agent x is managed outside Zorvo")`; unknown id: `Err("Unknown agent 'nope'")`; newer offered: `Ok(entry)` with `entry.version == "1.1.0"`.
  - `catalog_serialises_in_camel_case` — `serde_json::to_value` has `updateVersion`, `availableFrom`, `lastChecked`.

- [ ] **Step 2: Run and see them fail.** Run: `cargo test --test registry_catalog_view_test`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** the interfaces above. `get_agent_catalog` is `with_system_tools(|catalog, tools| catalog.catalog_view(tools, &versions_in_use(&store), registry::unix_now()))`; register it in `generate_handler!`.

- [ ] **Step 4: Run and see them pass.** Run: `cargo test --test registry_catalog_view_test && cargo clippy --all-targets -- -D warnings`. Expected: PASS, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/registry/resolve.rs src-tauri/src/registry/history.rs src-tauri/src/registry/catalog_view.rs src-tauri/src/registry/mod.rs src-tauri/src/lib.rs src-tauri/tests/registry_catalog_view_test.rs
git commit -m "feat: add the agent catalog read model"
```

### Task 4: `update_agent`

**Files:**
- Modify: `src-tauri/src/installer/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register)

**Interfaces:**
- Consumes: Task 3 `Catalog::update_target`; existing `install_steps_for`, `run_plan`, `run_with_user_env`, `profiles_changed`, `versions_in_use`.
- Produces: `#[tauri::command(async)] pub fn update_agent(app: AppHandle, store: State<'_, AppStore>, installer: State<'_, AppInstaller>, agent_id: String) -> Result<String, String>` returning the new version; private `fn versions_with(versions: &BTreeMap<String, String>, id: &str, version: &str) -> BTreeMap<String, String>` (a copy, the input untouched).

- [ ] **Step 1: Write the failing unit tests** in `installer/commands.rs`'s test module:
  - `versions_with_moves_only_the_one_agent` — `{a: 1.0.0, b: 2.0.0}` with `a → 1.1.0` gives `{a: 1.1.0, b: 2.0.0}` and the input still has `a: 1.0.0`.

- [ ] **Step 2: Run and see it fail.** Run: `cargo test --lib installer::commands`. Expected: FAIL.

- [ ] **Step 3: Implement `update_agent`:** `installer.get()?`; canonical id; `versions = versions_in_use(&store)`; `target = with_system_tools(|c, t| c.update_target(id, t, &versions, registry::unix_now()))?`; `job = installer.begin(id, &target.name)?`; `steps = install_steps_for(id, &versions_with(&versions, id, &target.version))`; `run_plan(&steps, |s| run_with_user_env(&app, installer, &job, s), || profiles_changed(&app))?`; `Ok(target.version)`. Register in `generate_handler!`.

- [ ] **Step 4: Run and see it pass.** Run: `cargo test --lib installer::commands && cargo clippy --all-targets -- -D warnings`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/installer/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add update_agent, which moves an agent to its offered version"
```

### Task 5: Registry icons

**Files:**
- Create: `src-tauri/src/registry/icons.rs`
- Modify: `src-tauri/src/registry/mod.rs` (`pub mod icons;`, `Catalog::icon_sources`, `Catalog::refresh_icons`, `Catalog::icon_data_urls`, call in `refresh_catalog`)
- Modify: `src-tauri/src/lib.rs` (command `get_agent_icons`)
- Create: `src-tauri/resources/registry-icons.json`
- Create: `scripts/registry-icons.mjs`, `scripts/registry-icons.test.mjs`
- Modify: `scripts/registry-update.mjs` (writes icons; `--icons-only` flag)
- Test: `src-tauri/tests/registry_icons_test.rs` (new)

**Interfaces:**

```rust
// icons.rs
pub const ICON_URL_PREFIX: &str = "https://cdn.agentclientprotocol.com/";
pub const MAX_ICON_BYTES: u64 = 64 * 1024;
pub const ICON_TIMEOUT: Duration = Duration::from_secs(10);
pub const BUNDLED_ICONS: &str = include_str!("../../resources/registry-icons.json"); // {id: svg}
pub struct IconSource { pub id: String, pub version: String, pub url: String }
pub fn is_allowed_icon_url(url: &str) -> bool;
pub fn is_svg(body: &str) -> bool;
/// Downloads changed icons into `dir` (`<id>.svg` + `index.json` {id: {url, version}}, atomic writes); true when any changed.
pub fn refresh_icons(dir: &Path, sources: &[IconSource], fetch: impl Fn(&str) -> Result<String, String>) -> bool;
/// `{id: "data:image/svg+xml;base64,…"}`: cached SVGs that pass `is_svg`, then bundled ones for the other ids.
pub fn icon_data_urls(dir: Option<&Path>, bundled_json: &str) -> BTreeMap<String, String>;

// mod.rs
impl Catalog {
    pub fn icon_sources(&self) -> Vec<IconSource>;   // listed ids, the listed version's entry.icon
    pub fn refresh_icons(&self, fetch: impl Fn(&str) -> Result<String, String>) -> bool; // no-op without data_dir
    pub fn icon_data_urls(&self) -> BTreeMap<String, String>;
}
// lib.rs
#[tauri::command(async)] fn get_agent_icons() -> BTreeMap<String, String>;
```

```js
// scripts/registry-icons.mjs
export const ICON_URL_PREFIX = "https://cdn.agentclientprotocol.com/";
export const MAX_ICON_BYTES = 64 * 1024;
export const isAllowedIconUrl = (url) => boolean;
export const isSvg = (text) => boolean;
export const bundleIcons = async (entries, fetchText) => ({ [id]: svg }); // sorted keys; skips disallowed, oversized, non-SVG
```

- [ ] **Step 1: Write the failing tests**
  - Rust `registry_icons_test.rs` (temp dir, injected fetch that records the URLs it was called with):
    - `only_cdn_https_urls_are_allowed` — `https://cdn.agentclientprotocol.com/registry/v1/latest/a.svg` true; `http://cdn…`, `https://evil.example/a.svg`, `https://cdn.agentclientprotocol.com.evil.example/a.svg` false.
    - `is_svg_accepts_svg_with_an_xml_prolog` — `"  <?xml version=\"1.0\"?>\n<svg …"` true; `"<html>"`, `"\u{89}PNG"`, `""` false.
    - `a_new_icon_is_downloaded_and_cached` — `refresh_icons` returns true, `<id>.svg` exists, `icon_data_urls` maps id to `data:image/svg+xml;base64,` + base64 of the body.
    - `an_unchanged_icon_is_not_downloaded_again` — second call with the same url and version makes no fetch, returns false.
    - `a_changed_version_downloads_again`.
    - `a_failed_or_non_svg_download_keeps_the_old_copy` — fetch `Err` and fetch `Ok("<html>")` both leave the cached file and return false.
    - `a_disallowed_url_is_never_fetched`.
    - `a_corrupt_cache_is_treated_as_empty` — `index.json` = `"nope"` → the next refresh fetches; a cached `<id>.svg` containing `"<html>"` is left out of `icon_data_urls`.
    - `bundled_icons_fill_ids_without_a_cached_copy`.
  - JS `scripts/registry-icons.test.mjs` (Vitest): `isAllowedIconUrl` and `isSvg` cases mirroring the Rust ones; `bundleIcons` keeps only valid icons and sorts keys.

- [ ] **Step 2: Run and see them fail.** Run: `cargo test --test registry_icons_test` and `pnpm vitest run scripts/registry-icons.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `refresh_catalog`, after a successful fetch, call `catalog.refresh_icons(|url| fetch_registry(url, ICON_TIMEOUT, MAX_ICON_BYTES))` and OR its result into the returned "changed" flag (so `agent-profiles-changed` follows). `registry-update.mjs` writes `src-tauri/resources/registry-icons.json` from `bundleIcons`; with `--icons-only` it writes only that file. Generate the committed file with `node scripts/registry-update.mjs --icons-only` (it fetches the real CDN; that is the maintainer workflow).

- [ ] **Step 4: Run and see them pass.** Run: `cargo test --test registry_icons_test && cargo clippy --all-targets -- -D warnings && pnpm vitest run scripts/registry-icons.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/registry/icons.rs src-tauri/src/registry/mod.rs src-tauri/src/lib.rs src-tauri/resources/registry-icons.json scripts/registry-icons.mjs scripts/registry-icons.test.mjs scripts/registry-update.mjs src-tauri/tests/registry_icons_test.rs
git commit -m "feat: cache and bundle the registry's agent icons"
```

### Task 6: Catalog types, pure helpers and `useAgentCatalog`

**Files:**
- Modify: `src/types/index.ts` (catalog types)
- Create: `src/lib/agent-catalog.ts`
- Create: `src/hooks/useAgentCatalog.ts`
- Create: `src/test/fixtures/catalog.ts`
- Modify: `src/test/setup.ts` (fakes: `get_agent_catalog` → `{ lastChecked: null, agents: fakeCatalog }`, `get_agent_icons` → `{}`, `update_agent` → the agent's `updateVersion` from `fakeCatalog`, `remove_agent_install` → `undefined`)
- Test: `src/test/agent-catalog.test.ts`, `src/test/use-agent-catalog.test.tsx`

**Interfaces:**

```ts
// types/index.ts
export type CatalogStatus = 'by_zorvo' | 'on_your_mac' | 'ready' | 'not_installed' | 'unsupported' | 'waiting';
export interface CatalogAgent {
  id: string; name: string; description: string | null;
  distribution: 'npx' | 'uvx' | 'binary'; listed: boolean;
  version: string | null; updateVersion: string | null;
  status: CatalogStatus; availableFrom: number | null; location: string | null;
}
export interface AgentCatalog { lastChecked: number | null; agents: CatalogAgent[] }

// lib/agent-catalog.ts
export function matchesQuery(agent: CatalogAgent, query: string): boolean;          // trimmed, case-insensitive; name, id, description
export function catalogSections(agents: readonly CatalogAgent[], enabledIds: readonly string[], query: string):
  { inUse: CatalogAgent[]; others: CatalogAgent[] };                                // ordering per spec
export function statusLine(agent: CatalogAgent, plan: readonly InstallStep[] | null): string;
export function rowActions(agent: CatalogAgent, isInUse: boolean): { add: boolean; update: boolean; remove: boolean };
export function withAgentAdded(settings: Settings, id: string, current: readonly string[]): Settings;
export function withAgentRemoved(settings: Settings, id: string, current: readonly string[]): Settings;
export function pendingUpdates(agents: readonly CatalogAgent[], enabledIds: readonly string[]): CatalogAgent[];
export function formatAvailableFrom(seconds: number): string;   // "Oct 27" (en, month short, day numeric)
export function formatCheckedAgo(seconds: number, now: number): string; // "2 hours ago" via Intl.RelativeTimeFormat, reuse an existing helper in src/lib if there is one

// hooks/useAgentCatalog.ts
export function useAgentCatalog(): { catalog: AgentCatalog | null; error: string | null; reload: () => Promise<void> };
```

`current` is `enabledAgentIds(settings)` (from `lib/enabled-agents.ts`). Sections: **inUse** = enabled ids, those with `updateVersion` first, then by name; **others** = the rest: `by_zorvo`/`on_your_mac` first, then by name, `waiting` and `unsupported` last. Both filtered by `matchesQuery`. `statusLine` per the spec's table; `not_installed` with a non-empty plan → `"Not installed · Add installs " + describePlan(plan)`; append `" · No longer listed"` when `!listed`. `rowActions` per the spec's table (`update` only when `isInUse && updateVersion !== null`). `useAgentCatalog` loads on mount, reloads on `agent-profiles-changed`, sets `error` to the thrown message.

- [ ] **Step 1: Write the failing tests**
  - `catalogSections`: in-use agent with an update sorts first; installed before not installed; waiting and unsupported last; query `"  GEM "` matches "Gemini CLI" by name and an agent whose description contains "gem".
  - `statusLine`: every row of the spec table, including `"Managed outside Zorvo · /opt/homebrew/bin/opencode"`, `"Runs with uvx"`, `"Available from Oct 27"`, and the "No longer listed" suffix.
  - `rowActions`: `on_your_mac` binary in use → `{ add: false, update: false, remove: true }`; `waiting` not in use → all false.
  - `withAgentAdded` writes the full list (`["claude-acp","codex-acp","qwen-code","gemini"]` from defaults) and drops the id from `removedAgents`; returns a new object, input unchanged.
  - `withAgentRemoved` drops the id, adds it to `removedAgents` once, and sets `defaultAgentId` to `null` when it was that id (Review Focus 5); other `defaultAgentId` values are kept.
  - `pendingUpdates` returns only in-use agents with `updateVersion`.
  - `useAgentCatalog`: loads the fake catalog; an `agent-profiles-changed` event triggers a second `get_agent_catalog`; a rejected invoke sets `error`.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm vitest run src/test/agent-catalog.test.ts src/test/use-agent-catalog.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** the interfaces above.

- [ ] **Step 4: Run and see them pass.** Same command, then `pnpm lint`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/lib/agent-catalog.ts src/hooks/useAgentCatalog.ts src/test/fixtures/catalog.ts src/test/setup.ts src/test/agent-catalog.test.ts src/test/use-agent-catalog.test.tsx
git commit -m "feat: add catalog types, helpers and the useAgentCatalog hook"
```

### Task 7: Registry logos in `AgentLogo`

**Files:**
- Create: `src/lib/agent-icons.ts`
- Modify: `src/components/AgentLogo.tsx`
- Test: `src/test/agent-logo.test.tsx` (extend if it exists, else create)

**Interfaces:**
- Produces: `lib/agent-icons.ts` — module-level store like `lib/agent-installs.ts`: `loadAgentIcons(): Promise<void>` (invokes `get_agent_icons`, attaches one `agent-profiles-changed` listener that reloads), `agentIconOf(id: string): string | undefined`, `subscribeToAgentIcons(cb): () => void`, `useAgentIcon(id: string): string | undefined` (via `useSyncExternalStore`, triggers the first load), `resetAgentIcons()` for tests.
- `AgentLogo` order: bundled `LOGOS` → registry icon as `<span role="img" aria-label={name}>` (or `aria-hidden` when `name === ""`) with `bg-fg-muted` and inline `style={{ maskImage: url(dataUrl), WebkitMaskImage: url(dataUrl), maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center", width: size, height: size }}` → `Bot`.

- [ ] **Step 1: Write the failing tests:** `uses the bundled logo for claude-acp`; `renders a registry icon as a mask filled by a token` (fake `get_agent_icons` → `{ gemini: "data:image/svg+xml;base64,PHN2Zz4=" }`; the `role="img"` element named "Gemini CLI" has class `bg-fg-muted` and a `mask-image` containing the data URL); `falls back to the generic icon`; `reloads icons on agent-profiles-changed`.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm vitest run src/test/agent-logo.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.** Call `resetAgentIcons()` in `src/test/setup.ts`'s `afterEach`.

- [ ] **Step 4: Run and see them pass**, then `pnpm test` (design-token tests must stay green). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-icons.ts src/components/AgentLogo.tsx src/test/agent-logo.test.tsx src/test/setup.ts
git commit -m "feat: show registry agent logos, tinted by the theme"
```

### Task 8: Update in the install store, and `saveNow`

**Files:**
- Modify: `src/lib/agent-installs.ts` (new `startUpdate`)
- Modify: `src/hooks/useAgentInstall.ts` (expose `update`)
- Create: `src/components/InstallProgressLine.tsx` (moved out of `AgentInstallPanel.tsx`)
- Modify: `src/components/AgentInstallPanel.tsx` (import it)
- Modify: `src/hooks/usePersistedState.ts` (new `saveNow`)
- Test: `src/test/agent-installs.test.ts` (extend), `src/test/use-persisted-state.test.tsx` (extend or create)

**Interfaces:**
- Produces:
  - `startUpdate(agentId: string, onUpdated: (version: string) => void): void` — same entry, attempt, progress listener and cancel handling as `startInstall`, invoking `update_agent` with `{ agentId }`; on success settles to idle and calls `onUpdated(version)`; `INSTALL_CANCELLED` settles to idle; other errors settle to `failed` with the message. No-op while the entry is `installing`.
  - `InstallEntry` gains `action: 'install' | 'update'` (`IDLE_INSTALL.action` is `'install'`), so a row can say "Install failed: …" or "Update failed: …".
  - `AgentInstall.update: (onUpdated: (version: string) => void) => void` and `AgentInstall.action`.
  - `InstallProgressLine({ progress, onCancel }: { progress: InstallProgress | null; onCancel: () => void })`.
  - `PersistedStateHandle.saveNow: () => Promise<void>` — writes the latest state immediately (same `lastSavedRef` bookkeeping as the debounce and the pagehide flush), resolves after `save_app_state` resolves; a no-op before the initial load.

- [ ] **Step 1: Write the failing tests**
  - `startUpdate calls update_agent and reports the new version` — `onUpdated` receives `"1.1.0"`, the entry ends `idle`.
  - `startUpdate twice while running starts one job` (Review Focus 2) — two calls, one `update_agent` invoke; also a `startUpdate` while `startInstall` is running for the same id makes no invoke.
  - `a failed update shows the error` — entry `failed`, error is the rejection text; a cancelled one ends `idle` and `onUpdated` is not called.
  - `saveNow writes at once` — after an `updateState`, `saveNow()` resolves and `save_app_state` was called before the 300 ms debounce elapsed (fake timers), and the debounce does not write the same state again.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm vitest run src/test/agent-installs.test.ts src/test/use-persisted-state.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** the interfaces. Share the job-running body between `startInstall` and `startUpdate` (one function taking the command name and an `onDone`), so the attempt and cancel logic lives once.

- [ ] **Step 4: Run and see them pass**, then `pnpm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-installs.ts src/hooks/useAgentInstall.ts src/components/InstallProgressLine.tsx src/components/AgentInstallPanel.tsx src/hooks/usePersistedState.ts src/test/agent-installs.test.ts src/test/use-persisted-state.test.tsx
git commit -m "feat: run agent updates through the install store and save state on demand"
```

### Task 9: The catalog UI, Settings tabs and the catalog actions

**Files:**
- Create: `src/components/agents/AgentCatalog.tsx`
- Create: `src/components/agents/AgentCatalogRow.tsx`
- Create: `src/hooks/useAgentCatalogActions.ts`
- Modify: `src/components/SettingsPanel.tsx` (tabs, `max-w-2xl`, Check again moves to the Agents tab)
- Create: `src/components/AppSettingsDialog.tsx` (the `{isSettingsOpen && <SettingsPanel …/>}` block moved out of `App.tsx`, plus the catalog wiring)
- Modify: `src/App.tsx` (render `AppSettingsDialog`; net line count must not grow)
- Test: `src/test/agent-catalog-ui.test.tsx`, `src/test/settings-panel.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 6 helpers and `useAgentCatalog`, Task 7 `AgentLogo`, Task 8 `useAgentInstall` (`install`, `update`, `cancel`, `status`, `progress`, `error`), `InstallProgressLine`, `saveNow`.
- Produces:

```ts
// hooks/useAgentCatalogActions.ts
export interface AgentCatalogActions {
  addAgent: (id: string) => void;              // withAgentAdded; startInstall when the profile is not "ready"
  updateAgent: (id: string) => void;           // startUpdate; onUpdated records agentVersions[id], await saveNow(), refreshAgents(), reload catalog;
                                               // a failed update also reloads the catalog (a refused update emits no agent-profiles-changed)
  removeAgent: (id: string) => Promise<void>;  // stops running sessions, withAgentRemoved, invoke remove_agent_install; rejects with "Could not delete Zorvo's copy: <error>"
  runningSessionCount: (id: string) => number;
}
export function useAgentCatalogActions(args: {
  settings: Settings;
  updateState: PersistedStateHandle['updateState'];
  saveNow: () => Promise<void>;
  agents: readonly AgentProfile[];
  sessions: readonly Session[];
  stopSession: (sessionId: string) => Promise<boolean>;   // useAcpEngine's stop
  refreshAgents: () => Promise<void>;
  reloadCatalog: () => Promise<void>;
}): AgentCatalogActions;

// components/agents/AgentCatalog.tsx
export interface AgentCatalogProps {
  catalog: AgentCatalog | null; error: string | null;
  agents: readonly AgentProfile[];          // install_plan for status lines
  enabledIds: readonly string[];
  actions: AgentCatalogActions;
  onCheckAgain: () => Promise<void>;
  onRetryLoad: () => void;
}

// SettingsPanel props gain
initialTab?: 'general' | 'agents';
agentsPanel: ReactNode;
updateCount: number;
```

`removeAgent` marks each running session of that agent (`status === "running"`) `terminated` with `endedAt: Date.now()` after `stopSession` resolves, as `useAcpEngine.interrupt` does for a starting session. The row's Remove confirm is two-step in the row (Remove → the spec's question + **Remove** / **Cancel**), adding "Its open sessions stop." when `runningSessionCount(id) > 0`. Tabs are a `role="tablist"` with `role="tab"` buttons (`aria-selected`, Left/Right arrow keys move between them, `focus-ring`) and `role="tabpanel"`; the Agents tab label is `Agents` plus a count pill when `updateCount > 0`.

- [ ] **Step 1: Write the failing tests**
  - `AgentCatalog`: renders "In use (3)" and "All agents (n)"; typing in the search filters rows and shows `No agents match "zzz".`; "Registry checked …" shows when `lastChecked` is set; a load error shows `Could not load the agents: boom` and Try again calls `onRetryLoad`.
  - Add: clicking **Add** on a `ready` agent adds it to `enabledAgents` and makes no `install_agent` call; on a `not_installed` agent it also calls `install_agent` with `{ agentId }` and shows the progress line with Cancel.
  - Update: **Update to 1.1.0** calls `update_agent`, then the saved state has `agentVersions.<id> === "1.1.0"`, `save_app_state` ran, and `get_agent_profiles` and `get_agent_catalog` were reloaded.
  - Remove: **Remove** then confirm → `enabledAgents` no longer has it, `removedAgents` has it, `remove_agent_install` was called; a rejected `remove_agent_install` shows `Could not delete Zorvo's copy: …` and the agent stays disabled; with a running session the confirm text includes "Its open sessions stop." and `acp_stop_session` is called.
  - Review Focus 1: Remove while the row is installing → `remove_agent_install` called; when the pending `install_agent` then rejects with `INSTALL_CANCELLED`, the row shows **Add** and no progress bar.
  - Settings: tabs switch with click and arrow keys; `initialTab="agents"` opens on the catalog; the Agents tab shows `2` when `updateCount={2}`; General still has Appearance, Default agent, Recent folders, Run setup again.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm vitest run src/test/agent-catalog-ui.test.tsx src/test/settings-panel.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** the components, hook and wiring. `App.tsx` keeps `useAgentCatalog` (it is needed for the badge in Task 10) and passes what `AppSettingsDialog` needs.

- [ ] **Step 4: Run and see them pass**, then `pnpm lint && pnpm test`, and `wc -l src/App.tsx` ≤ 815. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/agents/AgentCatalog.tsx src/components/agents/AgentCatalogRow.tsx src/hooks/useAgentCatalogActions.ts src/components/SettingsPanel.tsx src/components/AppSettingsDialog.tsx src/App.tsx src/test/agent-catalog-ui.test.tsx src/test/settings-panel.test.tsx
git commit -m "feat: add the agent catalog to Settings with add, update and remove"
```

### Task 10: Update badge and notice

**Files:**
- Modify: `src/types/index.ts` (`Settings.notifiedUpdates?: Record<string, string>`)
- Modify: `src/lib/persistence.ts` (normalise `notifiedUpdates` like `agentVersions`)
- Modify: `src-tauri/src/store.rs` (`Settings.notified_updates: BTreeMap<String, String>`, so a save keeps it)
- Create: `src/hooks/useAgentUpdates.ts`
- Create: `src/components/UpdateNotice.tsx`
- Modify: `src/components/ProfileFooter.tsx` (`updateCount` prop: dot + label)
- Modify: `src/App.tsx` (render the notice; Show opens Settings on Agents; net lines must not grow)
- Test: `src/test/agent-updates.test.tsx`, `src/test/persistence.test.ts` (extend), `src-tauri/tests/store_test.rs` (extend)

**Interfaces:**
- Consumes: Task 6 `pendingUpdates`, Task 9 `SettingsPanel.initialTab`.
- Produces: `useAgentUpdates({ catalog, settings, updateState }): { updateCount: number; unnotified: CatalogAgent[]; acknowledge: () => void }` — `unnotified` = `pendingUpdates` whose `notifiedUpdates[id] !== updateVersion`; `acknowledge` records `notifiedUpdates[id] = updateVersion` for each of them. `UpdateNotice({ agents, onShow, onDismiss }: { agents: readonly CatalogAgent[]; onShow: () => void; onDismiss: () => void })` — renders nothing for an empty list. `ProfileFooter` gains `updateCount?: number`; the Settings `IconButton` label becomes `Settings, <n> updates` (`Settings, 1 update` for one) and shows a `bg-primary` dot.

- [ ] **Step 1: Write the failing tests**
  - one pending update → `Claude Code 1.1.0 is available.`; two → `2 agent updates are available.`
  - **Show** opens Settings on the Agents tab and records `notifiedUpdates`; **Dismiss** records it; after either, the notice is gone and stays gone for that version; a later `updateVersion` shows it again.
  - the footer label reads `Settings, 2 updates` with the dot; no dot at 0.
  - persistence: `notifiedUpdates` keeps string pairs and drops non-string values.
  - Rust store: a state with `notifiedUpdates` round-trips through save and load.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm vitest run src/test/agent-updates.test.tsx src/test/persistence.test.ts` and `cargo test --test store_test`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run and see them pass**, then `pnpm lint && pnpm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/lib/persistence.ts src-tauri/src/store.rs src/hooks/useAgentUpdates.ts src/components/UpdateNotice.tsx src/components/ProfileFooter.tsx src/App.tsx src/test/agent-updates.test.tsx src/test/persistence.test.ts src-tauri/tests/store_test.rs
git commit -m "feat: show a badge and a notice when agent updates are available"
```

### Task 11: Saved sessions of a removed agent

**Files:**
- Create: `src/components/RemovedAgentPanel.tsx`
- Modify: `src/App.tsx` (show it instead of `ComposerDock` for a session whose registry agent is not in use)
- Modify: `src/lib/popout-bridge.ts` (`PopoutAction` gains `{ kind: 'add-agent' }`; `SessionSnapshotPayload` gains `removedAgentName: string | null`)
- Modify: `src/components/PopoutApp.tsx`, `src/hooks/usePopoutHost.ts` (render the panel; forward and handle the action with `addAgent(session.profileId)`)
- Test: `src/test/removed-agent.test.tsx`, popout bridge test (extend)

**Interfaces:**
- Consumes: Task 9 `addAgent`.
- Produces: `RemovedAgentPanel({ agentName, onAdd }: { agentName: string; onAdd: () => void })` with the spec copy and a primary `Button` "Add <Agent>". Shown when `activeSession` is set, `activeAgent?.source === "registry"`, and `!isInUse(activeAgent, settings)`.

- [ ] **Step 1: Write the failing tests:** opening a saved session of a removed agent shows `Gemini CLI was removed. Add it again to continue this session.` and no composer; **Add Gemini CLI** puts it back in `enabledAgents`; the transcript is still rendered; a popout snapshot carries `removedAgentName` and its button sends `{ kind: "add-agent" }`, which the main window turns into the same Add.

- [ ] **Step 2: Run and see them fail.** Run: `pnpm vitest run src/test/removed-agent.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run and see them pass**, then `pnpm lint && pnpm test` and `wc -l src/App.tsx` ≤ 815. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/RemovedAgentPanel.tsx src/App.tsx src/lib/popout-bridge.ts src/components/PopoutApp.tsx src/hooks/usePopoutHost.ts src/test/removed-agent.test.tsx
git commit -m "feat: let a removed agent's saved sessions add the agent again"
```

(Add the extended popout test file's path to `git add` too.)

### Task 12: Onboarding uses the catalog

**Files:**
- Modify: `src/components/onboarding/AgentsStep.tsx` (renders an `agentsPanel: ReactNode`)
- Modify: `src/components/Onboarding.tsx` (passes `agentsPanel` through)
- Modify: `src/App.tsx` (passes the same `AgentCatalog` element it gives Settings)
- Modify: `src/lib/agent-readiness.ts` (remove `installHintFor` and its types if nothing else uses them)
- Delete or modify: the onboarding tests that asserted copy-paste install commands
- Test: `src/test/onboarding.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 9 `AgentCatalog` and `useAgentCatalogActions`.
- Produces: `AgentsStepProps = { agentsPanel: ReactNode }`; `OnboardingProps` gains `agentsPanel: ReactNode` and drops `onRecheckAgents` only if nothing else in onboarding uses it.

- [ ] **Step 1: Write the failing test:** the onboarding Agents step shows the catalog search field and an **Add** button; no `Copy install command for …` button exists.

- [ ] **Step 2: Run and see it fail.** Run: `pnpm vitest run src/test/onboarding.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement.** Expect overlap with sub-project 5 here; change only what this task needs.

- [ ] **Step 4: Run and see it pass**, then `pnpm lint && pnpm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/onboarding/AgentsStep.tsx src/components/Onboarding.tsx src/App.tsx src/lib/agent-readiness.ts src/test/onboarding.test.tsx
git commit -m "feat: use the agent catalog in onboarding"
```

(Add any deleted or changed test paths explicitly.)

### Task 13: Docs and the full gate

**Files:**
- Modify: `CHANGELOG.md` (one line under Unreleased)
- Modify: `CLAUDE.md` (Architecture: catalog read model `get_agent_catalog` / `registry/catalog_view.rs`; `update_agent` is the only way versions change; `registry/icons.rs` and `get_agent_icons`; `pnpm registry:update --icons-only`)
- Modify: `README.md` privacy section (icons come from the already-listed registry CDN)

- [ ] **Step 1: Write the docs.** CHANGELOG line: `- An Agents tab in Settings lists every ACP registry agent with search and logos, and adds, updates and removes them; onboarding uses the same list.`
- [ ] **Step 2: Run every gate:** `pnpm lint && pnpm test`, then in `src-tauri/`: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`. Expected: all pass. If `design-system-docs.test.ts` flags new tokens, update `docs/design-system/tokens.json` with `globals.css`.
- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md CLAUDE.md README.md
git commit -m "docs: describe the agent catalog, update_agent and registry icons"
```
