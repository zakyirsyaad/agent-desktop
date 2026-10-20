# ACP Agent Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents that are `needs_runtime` or `not_installed` install from inside Zorvo with one click: Zorvo's own Node.js and `uv`, binary agents from registry URLs, and per-agent npm prerequisites, every download checked against a SHA-256 known in advance.

**Architecture:** A new Rust module `src-tauri/src/installer/` (layout, download, archive, runtimes, prerequisites, plan, orchestration, commands). `registry/resolve.rs` reads what the installer has put on disk to decide availability, the program to run, `PATH` changes and an `install_plan`. The UI gets a hook and one panel in the new-session draft; sub-project 4 reuses both.

**Tech Stack:** Rust (Tauri 2, `ureq` 3.4.2 rustls, `sha2`, `flate2`, `tar`, `bzip2`, `zip`, `url`), React 19 + Tailwind 4, Vitest, Node scripts.

**Spec:** `docs/superpowers/specs/2026-10-19-acp-installer-design.md`

**Branch:** `feat/acp-installer`, cut from `feat/acp-registry-catalog` (rebase onto `main` once PR #48 merges).

## Global Constraints

- The webview sends only an agent id or a runtime kind; URLs, hashes, versions and npm packages come from `runtimes.json`, `prerequisites.rs` or a validated registry entry.
- User Node is used when `node --version` major is **≥ 22** (`MIN_USER_NODE_MAJOR = 22`); otherwise Zorvo's Node, its `bin` dir **prepended** to the agent's `PATH`.
- User `uvx` of any version is used; otherwise Zorvo's `uvx`, its dir **appended** to `PATH`. Prerequisite `bin` dirs are **appended**.
- Binary agents: `cmd` basename on `PATH` first, then `tools/agents/<id>/<version>/<cmd>`.
- Downloads: HTTPS only for every hop, ≤ 5 redirects (host may change), 30 s connect and response-header timeouts, fail after 60 s with no data, no overall timeout, ≤ 1 GiB, SHA-256 compared before unpacking.
- Unpacking: reject absolute paths, `..`, symlinks resolving outside the destination, hard links, devices, FIFOs; ≤ 4 GiB unpacked; ≤ 200,000 entries; keep exec bits and in-tree symlinks; set `+x` only on the agent's `cmd`.
- Formats by URL ending: `.tar.gz`, `.tgz`, `.tar.bz2`, `.zip`; anything else fails with "Zorvo cannot unpack this archive format".
- Everything is built in `tools/staging/<random>/` and becomes visible only by one `rename`; every failure deletes its staging dir.
- npm prerequisite install: `npm install -g --prefix <staging> --no-audit --no-fund <package>@<version>`, argument vector, 10-minute timeout.
- Installs happen only on an explicit call (`install_agent`, `install_runtime`); nothing downloads in the background.
- Network/filesystem/child-process commands are `#[tauri::command(async)]`. Files stay under 800 lines (`App.tsx` is at 806: add no more than the wiring lines in Task 11).
- UI copy: sentence case, short sentences, name the agents; design tokens only, `Button`/`IconButton` primitives, `focus-ring`.
- Conventional Commits; stage explicit paths (never `git add -A`). Gates: `pnpm lint`, `pnpm test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (Rust from `src-tauri/`, after `pnpm build`).

## Review Focus

1. **A `cmd` with a directory and `./`** (`./dist-package/cursor-agent`, `./Applications/junie.app/Contents/MacOS/junie`) must resolve to the file under the install dir, not to its basename. Test in Task 3 (`ensure_agent_command_*`) and Task 8 (`zorvo_copy_with_nested_cmd_runs_by_full_path`).
2. **`node` on `PATH` but no `npx` beside it, or `node --version` that hangs or prints garbage** must count as "no usable user Node", so Zorvo's Node is used. Tests in Task 5 and Task 8.
3. **Cancelling agent A while agent B waits on the same Node lock** must abort only A; B then takes the lock, finds no Node and downloads it. Test in Task 9.
4. **A response without `Content-Length` (chunked)** must stream with `total = None` and still stop at the 1 GiB cap. Test in Task 2.
5. **The data dir path contains a space** (`Application Support`); the npm `--prefix` and `PATH` entries must survive as single arguments. Test in Task 7.

---

### Task 1: Dependencies and the on-disk layout

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/installer/mod.rs`, `src-tauri/src/installer/layout.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod installer;`)
- Test: `src-tauri/tests/installer_layout_test.rs`

**Interfaces:**
- Produces:
  - `pub struct ToolsDir` with `new(data_dir: &Path) -> Self` (root `data_dir/tools`), `root()`, `node_dir(version, platform)`, `uv_dir(version, platform)` (both `<kind>/<version>-<platform>`), `agent_dir(id, version)`, `prereq_dir(command, version)`, `staging_root()`, `new_staging(&self) -> Result<Staging, String>`.
  - `pub struct Staging` with `path() -> &Path`, `download_path() -> PathBuf` (`<staging>/download`), `content_path() -> PathBuf` (`<staging>/content`, created), `commit(self, dest: &Path, record: &InstallRecord) -> Result<CommitOutcome, String>`. `Drop` deletes the staging dir.
  - `pub enum CommitOutcome { Installed, AlreadyPresent }`.
  - `#[derive(Serialize, Deserialize)] pub struct InstallRecord { pub source: String, pub sha256: Option<String>, pub installed_at: u64, pub bin: Option<String> }`, written as `install.json` in the committed dir; `pub fn read_record(dir: &Path) -> Option<InstallRecord>`.

- [ ] **Step 1: Add dependencies.** Move `sha2 = "0.11.1"` from `[dev-dependencies]` to `[dependencies]`; add `flate2 = "1"`, `tar = { version = "0.4", default-features = false }`, `bzip2 = { version = "0.5", default-features = false, features = ["libbz2-rs-sys"] }`, `zip = { version = "2", default-features = false, features = ["deflate-flate2"] }`. Run `cargo build`; expected: builds.

- [ ] **Step 2: Write the failing tests** in `tests/installer_layout_test.rs`:
  - `paths_follow_the_spec_layout`: `ToolsDir::new(d).agent_dir("opencode","1.19.3") == d/"tools/agents/opencode/1.19.3"`; `node_dir("24.11.1","darwin-aarch64") == d/"tools/node/24.11.1-darwin-aarch64"`.
  - `commit_moves_content_and_writes_the_record`: write `content/x`, commit to `agent_dir`; dest has `x` and `install.json` whose `source` round-trips; staging dir gone.
  - `dropping_an_uncommitted_staging_deletes_it`.
  - `commit_onto_an_existing_dir_keeps_it_and_reports_already_present`: pre-create dest with `old`; outcome `AlreadyPresent`, `old` still there, staging gone.
  - `two_stagings_get_different_dirs`.

- [ ] **Step 3: Run** `cargo test --test installer_layout_test`. Expected: FAIL (module missing).

- [ ] **Step 4: Implement `layout.rs`.** Staging names: `format!("{}-{}-{}", process::id(), nanos, counter)` with a static `AtomicU64` counter (no `rand` crate). `commit` creates `dest`'s parent, writes `install.json` into `content/`, then `fs::rename(content, dest)`; when `dest` exists returns `AlreadyPresent` without touching it.

- [ ] **Step 5: Run** the tests. Expected: PASS. Then `cargo clippy --all-targets -- -D warnings`.

- [ ] **Step 6: Commit**
```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/installer/mod.rs src-tauri/src/installer/layout.rs src-tauri/tests/installer_layout_test.rs
git commit -m "feat: add the installer's on-disk layout"
```

### Task 2: Verified downloads

**Files:**
- Create: `src-tauri/src/installer/download.rs`
- Test: `src-tauri/tests/installer_download_test.rs`

**Interfaces:**
- Produces:
  - `pub struct DownloadLimits { pub max_bytes: u64, pub connect_timeout: Duration, pub stall_timeout: Duration, pub max_redirects: u32, pub require_https: bool }` with `pub fn production() -> Self` = `{1 << 30, 30 s, 60 s, 5, true}`.
  - `pub fn download(url: &str, expected_sha256: &str, dest: &Path, limits: &DownloadLimits, cancel: &AtomicBool, on_progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<(), DownloadError>`.
  - `pub enum DownloadError { Cancelled, Network { host: String, reason: String }, Stalled, TooLarge { max: u64 }, ChecksumMismatch, InsecureUrl { url: String }, TooManyRedirects, DiskFull, Io(String) }` with `pub fn user_message(&self, name: &str) -> String` producing the spec's copy: `Could not download {name} from {host} ({reason})`, `The download of {name} stalled`, `{name} is larger than Zorvo allows (1 GiB)`, `The download of {name} did not match its checksum`, `Not enough disk space to install {name}`.

- [ ] **Step 1: Write the failing tests** with a local server helper (copy the `serve_once` pattern from `tests/registry_fetch_test.rs`, extended to serve a sequence of canned responses and to send a partial body then sleep). Test limits: `require_https: false`, `stall_timeout: 1 s`, `max_bytes` per test.
  - `writes_the_body_when_the_hash_matches` (also asserts the last progress call is `(len, Some(len))`).
  - `fails_on_a_hash_mismatch_and_leaves_no_file`.
  - `fails_at_once_when_content_length_exceeds_the_cap`.
  - `stops_a_chunked_body_at_the_cap` (no `Content-Length`; progress totals are `None`) — Review Focus 4.
  - `follows_a_redirect_to_another_port` and `fails_after_more_than_max_redirects` (6 hops).
  - `rejects_an_http_url_when_https_is_required` (`require_https: true`, `http://127.0.0.1…` → `InsecureUrl`, no request reaches the server).
  - `rejects_a_redirect_to_http_when_https_is_required`: unit test of `next_location(current: &Url, location: &str, require_https: bool) -> Result<Url, DownloadError>` in a `#[cfg(test)]` module of `download.rs` (`https://a/x` + `http://b/y` → `InsecureUrl`; relative `../y` resolves against current).
  - `reports_a_stall` (headers + 10 bytes, then sleep 3 s → `Stalled` within ~2 s).
  - `stops_when_cancelled` (flag set from the progress callback after the first chunk → `Cancelled`, no file).
  - `user_message_names_the_agent_and_host` for `Network` and `ChecksumMismatch`.

- [ ] **Step 2: Run** `cargo test --test installer_download_test`. Expected: FAIL.

- [ ] **Step 3: Implement.** One `ureq::Agent` with `max_redirects(0)`, `http_status_as_error(false)`, `timeout_connect`, `timeout_recv_response`, no global or body timeout. Follow redirects in a loop with `next_location` (the `url` crate resolves relative `Location`). Read the body on a spawned thread that sends 64 KiB chunks over a channel; the calling thread `recv_timeout(250 ms)`s, checks `cancel` each tick and the stall deadline, hashes with `sha2::Sha256` and writes to `dest`. Map `ErrorKind::StorageFull` (ENOSPC) to `DiskFull`. On any error delete `dest`. Progress at most every 250 ms plus a final call.

- [ ] **Step 4: Run** the tests. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/installer/download.rs src-tauri/src/installer/mod.rs src-tauri/tests/installer_download_test.rs
git commit -m "feat: download files checked against a pinned SHA-256"
```

### Task 3: Safe unpacking

**Files:**
- Create: `src-tauri/src/installer/archive.rs`
- Test: `src-tauri/tests/installer_archive_test.rs`

**Interfaces:**
- Produces:
  - `pub enum ArchiveFormat { TarGz, TarBz2, Zip }`; `pub fn format_for_url(url: &str) -> Option<ArchiveFormat>` (ignores query/fragment; `.tar.gz`, `.tgz`, `.tar.bz2`, `.zip`).
  - `pub struct UnpackLimits { pub max_total_bytes: u64, pub max_entries: u64 }` with `production()` = `{4 << 30, 200_000}`.
  - `pub fn unpack(archive: &Path, format: ArchiveFormat, dest: &Path, limits: &UnpackLimits, cancel: &AtomicBool) -> Result<(), UnpackError>`.
  - `pub enum UnpackError { UnsafeEntry(String), TooLarge, TooManyEntries, Cancelled, Io(String) }` with `user_message(&self, name: &str) -> String` (`{name}'s archive contains a file Zorvo will not unpack: {path}`).
  - `pub fn ensure_agent_command(dest: &Path, cmd: &str) -> Result<PathBuf, String>`: strips a leading `./`, requires a regular file inside `dest`, adds `0o111` when no exec bit is set, returns the absolute path; error copy `{cmd} is not in the archive` (orchestrator prefixes the agent name: `{name}'s archive does not contain {cmd}`).

- [ ] **Step 1: Write the failing tests.** Build archives in a temp dir with `tar::Builder` (+ `flate2::write::GzEncoder` / `bzip2::write::BzEncoder`) and `zip::ZipWriter` (stored entries; `add_symlink` for links; raw header bytes where the builder refuses a bad path, e.g. `tar::Header::set_path` bypass via `as_old_mut().name`). For each of the three formats:
  - `unpacks_files_dirs_and_exec_bits`.
  - `keeps_a_symlink_that_stays_inside` (`bin/npx -> ../lib/npx-cli.js`).
  - `rejects_an_absolute_path`, `rejects_a_parent_dir_component`, `rejects_a_symlink_leaving_the_destination` (`a -> ../../etc`), `rejects_an_absolute_symlink`.
  - tar only: `rejects_a_hard_link`, `rejects_a_fifo`.
  - `stops_at_the_entry_cap` (limits `{.., max_entries: 3}`, 4 files) and `stops_at_the_size_cap`.
  - `format_for_url_reads_the_ending`: `…/coco-1.0.73%2B180523.e6179a031de9-darwin-arm64.tar.gz` → `TarGz`; `x.tgz?sig=1` → `TarGz`; `x.tar.xz` → `None`.
  - `ensure_agent_command_sets_the_exec_bit_on_cmd_only`, `ensure_agent_command_finds_a_nested_cmd` (`./dist-package/cursor-agent`) — Review Focus 1, `ensure_agent_command_rejects_a_missing_cmd`, `ensure_agent_command_rejects_a_symlink_out`.

- [ ] **Step 2: Run** `cargo test --test installer_archive_test`. Expected: FAIL.

- [ ] **Step 3: Implement.** Iterate entries yourself (never `Archive::unpack` / `ZipArchive::extract`). Per entry: compute the relative path from components, rejecting `RootDir`, `Prefix`, `ParentDir`; for a symlink, lexically normalize `entry_parent.join(target)` and require it to stay under `dest` (absolute targets rejected); count entries and bytes against limits before writing; set mode `& 0o777` from the archive (zip: `unix_mode()`, default 0o644). Check `cancel` between entries.

- [ ] **Step 4: Run** the tests. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/installer/archive.rs src-tauri/src/installer/mod.rs src-tauri/tests/installer_archive_test.rs
git commit -m "feat: unpack tar.gz, tar.bz2 and zip archives entry by entry"
```

### Task 4: Pinned runtimes manifest and `pnpm runtimes:update`

**Files:**
- Create: `scripts/runtimes-update.mjs`, `scripts/runtimes.mjs`, `scripts/runtimes.test.mjs`, `src-tauri/resources/runtimes.json`
- Modify: `package.json` (`"runtimes:update": "node scripts/runtimes-update.mjs"`)

**Interfaces:**
- Produces: `src-tauri/resources/runtimes.json` in the shape of the spec's *runtimes.json* section (`node` and `uv`, each `{version, released, targets: {darwin-aarch64, darwin-x86_64: {url, sha256, size, bin}}}`). Node `bin` = `node-v<version>-darwin-<arm64|x64>/bin`; uv `bin` = `uv-<aarch64|x86_64>-apple-darwin` (the dir holding `uv` and `uvx`). Node archives are the `.tar.gz` files.
- `scripts/runtimes.mjs` exports pure helpers: `pickNodeRelease(indexJson, nowMs)`, `pickUvRelease(releasesJson, nowMs)`, `parseShasums(text, filename)`, `isOldEnough(dateIso, nowMs)` (≥ 7 × 24 h).

- [ ] **Step 1: Write the failing tests** in `scripts/runtimes.test.mjs` (Vitest picks up `scripts/*.test.mjs` like `registry-history.test.mjs`):
  - `pickNodeRelease` returns the newest entry with `lts !== false` dated ≥ 7 days before now, and skips a newer LTS dated 6 days ago.
  - `pickUvRelease` skips drafts, prereleases and a release published 6 days ago.
  - `parseShasums` finds the hash for `node-v24.11.1-darwin-arm64.tar.gz` and returns `null` for a missing file.

- [ ] **Step 2: Run** `pnpm vitest run scripts/runtimes.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** the helpers, then `runtimes-update.mjs`: fetch `https://nodejs.org/dist/index.json`, the chosen release's `SHASUMS256.txt`, `https://api.github.com/repos/astral-sh/uv/releases` and each `uv-<arch>-apple-darwin.tar.gz.sha256`; download every archive, compare SHA-256 and record its size; exit non-zero on any mismatch; write the file with 2-space JSON and a trailing newline.

- [ ] **Step 4: Run** the tests (PASS), then `pnpm runtimes:update` and inspect `src-tauri/resources/runtimes.json` (two runtimes × two targets, 64-hex hashes, sizes > 0).

- [ ] **Step 5: Commit**
```bash
git add scripts/runtimes-update.mjs scripts/runtimes.mjs scripts/runtimes.test.mjs src-tauri/resources/runtimes.json package.json
git commit -m "feat: pin Zorvo's Node.js and uv with pnpm runtimes:update"
```

### Task 5: Runtime manifest parsing and runtime choice

**Files:**
- Create: `src-tauri/src/installer/runtimes.rs`
- Test: `src-tauri/tests/installer_runtimes_test.rs`

**Interfaces:**
- Consumes: `ToolsDir`, `read_record` (Task 1).
- Produces:
  - `#[serde(rename_all = "lowercase")] pub enum RuntimeKind { Node, Uv }` with `pub fn parse(kind: &str) -> Option<Self>` and `display_name()` (`"Node.js"`, `"uv"`).
  - `pub struct RuntimeTarget { pub url, pub sha256, pub size: u64, pub bin }`, `pub struct RuntimeRelease { pub version, pub released, pub targets: BTreeMap<String, RuntimeTarget> }`, `pub struct RuntimeManifest { pub node: RuntimeRelease, pub uv: RuntimeRelease }` with `release(kind) -> &RuntimeRelease`.
  - `pub const BUNDLED_RUNTIMES: &str = include_str!("../../resources/runtimes.json");`
  - `pub fn parse_manifest(json: &str) -> Result<RuntimeManifest, String>`.
  - `pub const MIN_USER_NODE_MAJOR: u32 = 22;` `pub fn parse_node_major(output: &str) -> Option<u32>`.
  - `pub fn user_node_major(env: &HashMap<String, String>, timeout: Duration) -> Option<u32>`: `None` unless both `node` and `npx` are on the env's `PATH` and `node --version` parses within `timeout` (5 s in production).
  - `pub struct InstalledRuntime { pub version: String, pub bin_dir: PathBuf }`; `pub fn installed_runtime(tools: &ToolsDir, kind: RuntimeKind, manifest: &RuntimeManifest, platform: &str) -> Option<InstalledRuntime>`: the pinned version's dir when present, else any other installed version (its `bin` from `install.json`).

- [ ] **Step 1: Write the failing tests:**
  - `the_committed_manifest_is_valid` (`parse_manifest(BUNDLED_RUNTIMES).is_ok()` and both darwin targets exist for both runtimes).
  - Rejections, one test each: Node URL not under `https://nodejs.org/dist/`; uv URL not under `https://github.com/astral-sh/uv/releases/download/`; `sha256` of 63 chars; `bin` absolute; `bin` with `..`.
  - `parse_node_major`: `"v22.0.0\n"` → 22, `"v20.18.1"` → 20, `"node"` → None, `""` → None.
  - `user_node_major_needs_npx_beside_node` (temp dir with an executable `node` script printing `v24.1.0` and no `npx` → None; add `npx` → Some(24)) and `user_node_major_gives_up_after_the_timeout` (`node` sleeps 3 s, timeout 1 s → None) — Review Focus 2.
  - `installed_runtime_prefers_the_pinned_version` and `installed_runtime_falls_back_to_an_older_install` (older dir with `install.json` `bin`).

- [ ] **Step 2: Run** `cargo test --test installer_runtimes_test`. Expected: FAIL.

- [ ] **Step 3: Implement.** Run `node --version` with `env_clear().envs(env)`, stdin null, killed at the timeout (reuse the pattern in `registry/npm_globals.rs`).

- [ ] **Step 4: Run** the tests. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/installer/runtimes.rs src-tauri/src/installer/mod.rs src-tauri/tests/installer_runtimes_test.rs
git commit -m "feat: choose between the user's and Zorvo's Node.js and uv"
```

### Task 6: Prerequisites table and npm install

**Files:**
- Create: `src-tauri/src/installer/prerequisites.rs`
- Test: `src-tauri/tests/installer_prerequisites_test.rs`

**Interfaces:**
- Produces:
  - `pub struct Prerequisite { pub command: &'static str, pub package: &'static str, pub version: &'static str }`.
  - `pub fn prerequisites_for(agent_id: &str) -> &'static [Prerequisite]`; `pi-acp` → `[Prerequisite { command: "pi", package: "@earendil-works/pi-coding-agent", version: <newest npm version published ≥ 7 days before this commit> }]`.
  - `pub fn npm_install_args(prefix: &Path, p: &Prerequisite) -> Vec<OsString>` = `["install", "-g", "--prefix", <prefix>, "--no-audit", "--no-fund", "<package>@<version>"]`.
  - `pub fn run_npm_install(npm: &Path, args: &[OsString], env: &HashMap<String, String>, timeout: Duration, cancel: &AtomicBool) -> Result<(), String>`; error = `npm could not install {package}` + the last 20 stderr lines; timeout 10 min in production.

- [ ] **Step 1: Look up the version:** `npm view @earendil-works/pi-coding-agent time --json`; pick the newest version whose date is ≥ 7 days ago.

- [ ] **Step 2: Write the failing tests:**
  - `pi_acp_needs_pi_at_an_exact_version` (version matches `^\d+\.\d+\.\d+$`; `prerequisites_for("gemini")` is empty).
  - `npm_install_args_keep_a_prefix_with_spaces_as_one_argument` (prefix `/tmp/Application Support/x`) — Review Focus 5.
  - `run_npm_install_reports_the_stderr_tail` (fake `npm` script that prints 30 lines to stderr and exits 1 → error contains line 30, not line 5).
  - `run_npm_install_stops_at_the_timeout` and `run_npm_install_stops_when_cancelled` (fake `npm` that sleeps).

- [ ] **Step 3: Run** `cargo test --test installer_prerequisites_test`. Expected: FAIL.

- [ ] **Step 4: Implement** (child killed on timeout or cancel, stderr drained on a thread with `env_resolver::drain_in_background`).

- [ ] **Step 5: Run** the tests. Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add src-tauri/src/installer/prerequisites.rs src-tauri/src/installer/mod.rs src-tauri/tests/installer_prerequisites_test.rs
git commit -m "feat: declare pi as pi-acp's prerequisite and install it with npm"
```

### Task 7: Installed-tools snapshot and the install plan

**Files:**
- Create: `src-tauri/src/installer/plan.rs`
- Test: `src-tauri/tests/installer_plan_test.rs`

**Interfaces:**
- Consumes: Tasks 1, 5, 6; `RegistryEntry`, `Distribution`, `current_platform` from `registry::schema`.
- Produces:
  - `pub struct InstalledTools { pub user_node_major: Option<u32>, pub node: Option<InstalledRuntime>, pub uv: Option<InstalledRuntime>, pub pinned_node_installed: bool, pub pinned_uv_installed: bool, pub agents: BTreeMap<(String, String), PathBuf>, pub prereq_bins: BTreeMap<String, PathBuf>, pub manifest: Option<RuntimeManifest> }` with `pub fn none() -> Self` and `pub fn scan(tools: &ToolsDir, manifest: &RuntimeManifest, platform: &str, user_node_major: Option<u32>) -> Self` (`agents` keyed `(id, version)` → install dir; `prereq_bins` keyed by command → `<prefix>/bin`, only the pinned version).
  - `pub enum PlannedStep { Runtime(RuntimeKind), Agent { id: String, name: String, version: String, url: String, sha256: String, cmd: String }, Prerequisite(&'static Prerequisite) }`.
  - `#[derive(Serialize)] pub struct InstallStep { pub kind: String /* "node"|"uv"|"agent"|"prerequisite" */, pub name: String, pub version: String, pub download_bytes: Option<u64> }` and `impl PlannedStep { pub fn display(&self, manifest: Option<&RuntimeManifest>, platform: &str) -> InstallStep }` (runtime size from the manifest; `None` for agents and prerequisites; prerequisite name = command).

- [ ] **Step 1: Write the failing tests:** `scan_finds_agents_runtimes_and_prereqs` (build the dirs and `install.json` by hand), `scan_ignores_staging`, `display_of_a_node_step_has_the_manifest_size`, `display_of_an_agent_step_has_no_size`.

- [ ] **Step 2: Run** `cargo test --test installer_plan_test`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** the tests. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/installer/plan.rs src-tauri/src/installer/mod.rs src-tauri/tests/installer_plan_test.rs
git commit -m "feat: snapshot what Zorvo installed and describe install steps"
```

### Task 8: Resolution uses installed tools

**Files:**
- Modify: `src-tauri/src/registry/resolve.rs`, `src-tauri/src/profiles.rs` (`AgentProfile`, `agent_profiles`), `src-tauri/src/registry/mod.rs` (`refresh_catalog`), `src-tauri/src/acp/commands.rs` (`launch_for`), `src-tauri/src/installer/mod.rs`
- Modify: `src/types/index.ts` (`AgentProfile`), `src/test/fixtures/agents.ts`
- Test: `src-tauri/tests/registry_resolve_test.rs`, `src-tauri/tests/profiles_test.rs`

**Interfaces:**
- Consumes: `InstalledTools`, `PlannedStep`, `InstallStep` (Task 7), `prerequisites_for` (Task 6), `MIN_USER_NODE_MAJOR` (Task 5).
- Produces:
  - `SystemTools` gains `pub installed: &'a InstalledTools`.
  - `pub fn planned_steps(entry: &RegistryEntry, tools: &SystemTools) -> Vec<PlannedStep>` in `resolve.rs`: empty when the agent is ready; otherwise runtime step (only when the agent needs Zorvo's runtime and the pinned version is not installed), then missing prerequisites, then the agent archive.
  - `AgentProfile` gains `pub install_plan: Option<Vec<InstallStep>>` (serialized) and `#[serde(skip)] pub acp_path_prepend: Vec<String>`, `#[serde(skip)] pub acp_path_append: Vec<String>`.
  - `installer::set_tools_dir(ToolsDir)` (OnceLock, called in setup), `installer::set_user_node_major(Option<u32>)` and `installer::installed_tools() -> InstalledTools` (scan of the set dir with `BUNDLED_RUNTIMES`, or `InstalledTools::none()` when unset).
  - TS: `install_plan: InstallStep[] | null` and `export interface InstallStep { kind: 'node' | 'uv' | 'agent' | 'prerequisite'; name: string; version: string; download_bytes: number | null }`.

- [ ] **Step 1: Write the failing tests** in `registry_resolve_test.rs` (extend its `SystemTools` builder with `installed`):
  - `npx_with_a_new_enough_user_node_is_ready_and_leaves_path_alone` (user_node_major 22).
  - `npx_with_an_old_user_node_uses_zorvos_node_first_on_path` (20 + Zorvo Node → program `<bin>/npx`, `acp_path_prepend == [bin]`).
  - `npx_with_an_old_user_node_and_no_zorvo_node_needs_the_runtime` (plan `[node]` with size).
  - `uvx_without_user_uvx_uses_zorvos_uvx_appended`.
  - `binary_on_path_beats_zorvos_copy`; `zorvo_copy_at_the_version_in_use_is_ready`; `zorvo_copy_with_nested_cmd_runs_by_full_path` (Review Focus 1); `zorvo_copy_at_another_version_is_not_installed` (plan `[agent]`).
  - `pi_acp_without_pi_is_not_installed_with_a_prerequisite_step`; `pi_acp_with_pi_on_path_is_ready`; `pi_acp_with_zorvos_pi_appends_its_bin`.
  - `not_ready_npx_agent_with_an_older_zorvo_node_plans_the_pinned_node` (prereq missing + older Node installed → plan `[node, prerequisite]`).
  - `ready_profile_has_no_install_plan`.
  - `missing_reason` for a missing prerequisite: `"Pi needs pi, which was not found"` (agent name, then command).
  - Update existing tests that assumed "npx on PATH ⇒ ready" to set `user_node_major: Some(22)`.

- [ ] **Step 2: Run** `cargo test --test registry_resolve_test`. Expected: FAIL.

- [ ] **Step 3: Implement** in `resolve.rs`; `profiles.rs::agent_profiles` passes `installer::installed_tools()`; `registry::refresh_catalog` also calls `installer::set_user_node_major(user_node_major(env, NODE_VERSION_TIMEOUT))` (5 s); `launch_for` builds `PATH` as `prepend ++ user PATH ++ append` (joined with `:`) before adding registry env. Add `install_plan: null` to the TS fixtures.

- [ ] **Step 4: Run** `cargo test` and `pnpm lint && pnpm test`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/registry/resolve.rs src-tauri/src/registry/mod.rs src-tauri/src/profiles.rs src-tauri/src/acp/commands.rs src-tauri/src/installer/mod.rs src-tauri/tests/registry_resolve_test.rs src-tauri/tests/profiles_test.rs src/types/index.ts src/test/fixtures/agents.ts
git commit -m "feat: run agents with the runtimes and copies Zorvo installed"
```

### Task 9: The installer orchestration

**Files:**
- Create: `src-tauri/src/installer/install.rs`
- Modify: `src-tauri/src/installer/mod.rs`
- Test: `src-tauri/tests/installer_install_test.rs`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces:
  - `#[derive(Serialize, Clone)] #[serde(rename_all = "camelCase")] pub struct InstallProgress { pub agent_id: String, pub step_index: usize, pub step_count: usize, pub kind: String, pub name: String, pub phase: String /* download|verify|unpack|npm */, pub received_bytes: u64, pub total_bytes: Option<u64> }`.
  - `pub const INSTALL_CANCELLED: &str = "INSTALL_CANCELLED";`
  - `pub struct Installer` with `pub fn new(tools: ToolsDir, manifest: RuntimeManifest, platform: String, download: DownloadLimits, unpack: UnpackLimits) -> Self`.
  - `pub fn run(&self, job_id: &str, steps: &[PlannedStep], env: &HashMap<String, String>, on_progress: &(dyn Fn(InstallProgress) + Sync)) -> Result<(), String>`: rejects a second run with the same `job_id` (`"{job_id} is already installing"`); for each step takes the target lock (`node`, `uv`, `agent:<id>`, `prereq:<command>`), re-checks presence on disk (skip if present), then stages, downloads, verifies, unpacks, commits; prerequisites use npm from the user's Node when `user_node_major ≥ 22` else Zorvo's Node bin (re-scanned after a runtime step), with that bin prepended to `PATH`. Returns `Err(INSTALL_CANCELLED)` when cancelled. An agent URL with no `format_for_url` match fails with `Zorvo cannot unpack this archive format`. Emits one progress event at each phase change besides the throttled download ones.
  - `pub fn cancel(&self, job_id: &str) -> bool`.
  - `pub fn remove_agent(&self, agent_id: &str, prereqs_still_needed: &BTreeSet<String>) -> Result<(), String>`: deletes `tools/agents/<id>` and prerequisites of that agent not in `prereqs_still_needed`.

- [ ] **Step 1: Write the failing tests** (local HTTP server serving tar.gz fixtures built in the test; `DownloadLimits { require_https: false, .. }`; a test manifest built in code pointing at the server):
  - `installs_a_binary_agent_and_reports_each_phase` (phases seen in order download → verify → unpack; dest has `cmd` executable).
  - `installs_a_runtime_then_skips_it_when_present` (second run downloads nothing: server receives one request).
  - `a_hash_mismatch_installs_nothing_and_empties_staging`.
  - `a_second_run_with_the_same_job_id_is_rejected`.
  - `two_agents_needing_node_download_it_once` (two threads; server counts requests for the node path = 1).
  - `cancelling_one_job_leaves_the_other_to_finish` (A and B both need Node; server stalls Node for A; cancel A; B downloads Node and succeeds; A returns `INSTALL_CANCELLED`) — Review Focus 3.
  - `remove_agent_keeps_prereqs_still_needed`.

- [ ] **Step 2: Run** `cargo test --test installer_install_test`. Expected: FAIL.

- [ ] **Step 3: Implement** (locks: `Mutex<HashMap<String, Arc<Mutex<()>>>>`; cancel flags: `Mutex<HashMap<String, Arc<AtomicBool>>>`, removed when the run ends; error strings via `DownloadError::user_message` / `UnpackError::user_message` with the step's display name).

- [ ] **Step 4: Run** the tests. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/installer/install.rs src-tauri/src/installer/mod.rs src-tauri/tests/installer_install_test.rs
git commit -m "feat: run install plans with per-target locks and cancellation"
```

### Task 10: Tauri commands, the progress event and clean-up at start

**Files:**
- Create: `src-tauri/src/installer/commands.rs`, `src-tauri/src/installer/cleanup.rs`
- Modify: `src-tauri/src/lib.rs` (setup + `generate_handler!`), `src-tauri/src/store.rs` (`Settings::enabled_agent_ids`), `src-tauri/src/acp/connection.rs`, `src-tauri/src/acp/manager.rs`
- Test: `src-tauri/tests/installer_cleanup_test.rs`, `src-tauri/tests/store_test.rs`, `src-tauri/tests/acp_manager_test.rs`

**Interfaces:**
- Consumes: Tasks 8–9; `AcpManager`, `AppStore`.
- Produces:
  - `pub const AGENT_INSTALL_PROGRESS: &str = "agent-install-progress";`
  - Commands: `install_agent(app: AppHandle, store: State<AppStore>, agent_id: String) -> Result<(), String>` (async; resolves the profile with the versions in use; rejects unknown ids and `ready` agents; emits progress; emits `agent-profiles-changed` on success), `install_runtime(app: AppHandle, kind: String) -> Result<(), String>` (async; job id `runtime:<kind>`; resolves at once when pinned is installed), `cancel_agent_install(agent_id: String) -> bool` (sync; `agent_id` is the job id, `runtime:<kind>` for a runtime), `remove_agent_install(app: AppHandle, store: State<AppStore>, acp: State<AcpManager>, agent_id: String) -> Result<(), String>` (async; deferred to next start when `acp.is_running_under(&agent_dir)`).
  - `Settings::enabled_agent_ids(&self) -> Vec<String>` (the stored list, else `["claude-acp", "codex-acp", "qwen-code"]`, matching `src/lib/enabled-agents.ts`).
  - `AcpConnection` records its `program: String`; `AcpManager::is_running_under(&self, dir: &Path) -> bool`.
  - `pub struct CleanupInputs { pub agents_in_use: BTreeMap<String, String> /* id -> version */, pub uses_npx: bool, pub uses_uvx: bool, pub prereqs_needed: BTreeSet<String> }`; `pub fn clean_up(tools: &ToolsDir, manifest: &RuntimeManifest, platform: &str, inputs: &CleanupInputs) -> Vec<String>` (returns the errors it logged).

- [ ] **Step 1: Write the failing tests:**
  - `installer_cleanup_test.rs`: `empties_staging`; `removes_versions_not_in_use`; `removes_agents_not_enabled`; `removes_an_old_runtime_once_the_pinned_one_is_installed` and `keeps_an_old_runtime_while_the_pinned_one_is_missing`; `removes_node_when_no_enabled_agent_uses_npx`; `removes_unneeded_prereqs`; `an_unremovable_dir_is_reported_not_fatal`.
  - `store_test.rs`: `enabled_agent_ids_defaults_to_the_three_built_ins`.
  - `acp_manager_test.rs`: `is_running_under_sees_a_session_started_from_that_dir` (start the fake agent from a copy under a temp dir).

- [ ] **Step 2: Run** those tests. Expected: FAIL.

- [ ] **Step 3: Implement.** In `lib.rs` setup: `installer::set_tools_dir(ToolsDir::new(&data_dir))`, manage one `Installer` (production limits, `BUNDLED_RUNTIMES`, `current_platform()`), and spawn clean-up on the existing background thread after `refresh_catalog` (inputs from the store's settings and the profiles' `distribution`). Register the four commands. A `parse_manifest` failure logs and installs no runtime (runtime steps then fail with "Zorvo's runtime list is not valid").

- [ ] **Step 4: Run** `cargo test` and `cargo clippy --all-targets -- -D warnings`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src-tauri/src/installer/commands.rs src-tauri/src/installer/cleanup.rs src-tauri/src/installer/mod.rs src-tauri/src/lib.rs src-tauri/src/store.rs src-tauri/src/acp/connection.rs src-tauri/src/acp/manager.rs src-tauri/tests/installer_cleanup_test.rs src-tauri/tests/store_test.rs src-tauri/tests/acp_manager_test.rs
git commit -m "feat: expose install commands and clean up old installs at start"
```

### Task 11: Install panel in the new-session draft

**Files:**
- Create: `src/hooks/useAgentInstall.ts`, `src/components/AgentInstallPanel.tsx`, `src/lib/install-plan.ts`
- Modify: `src/App.tsx` (picker options, draft agent choice, probe skip, panel, composer disabled), `src/test/setup.ts` (fake commands)
- Test: `src/test/agent-install.test.tsx`, `src/test/install-plan.test.ts`

**Interfaces:**
- Consumes: `install_plan`, `InstallStep` (Task 8); commands and event (Task 10); `agent-profiles-changed` already reloads profiles in `useDiscovery`.
- Produces:
  - `src/lib/install-plan.ts`: `export function describePlan(steps: readonly InstallStep[]): string` → `"Node.js 24.11.1 (49 MB) and OpenCode 1.19.3"` (MB = bytes / 1 048 576 rounded; steps joined with commas and a final "and").
  - `useAgentInstall(agentId: string | undefined): { status: 'idle' | 'installing' | 'failed'; progress: InstallProgress | null; error: string | null; install: () => void; cancel: () => void }` with `InstallProgress` mirroring the event payload. A rejection with `INSTALL_CANCELLED` returns to `idle` with no error.
  - `AgentInstallPanel({ agent }: { agent: AgentProfile })`: title `Install {name}`; body `{name} needs {describePlan} before it can start.`; **Install** button; while installing a `<progress>` with `aria-label="{step name} download"` (determinate when `totalBytes`), the phase line (`Downloading Node.js…`, `Checking Node.js…`, `Unpacking Node.js…`, `Installing pi with npm…`) and **Cancel**; on failure the error and **Retry**.

- [ ] **Step 1: Write the failing tests:**
  - `install-plan.test.ts`: two steps → `"Node.js 24.11.1 (49 MB) and OpenCode 1.19.3"`; three steps use `", "` then `" and "`; a step without size has no parentheses.
  - `agent-install.test.tsx` (mock `@tauri-apps/api/event` like `popout.test.tsx`; spy `invoke` passing others to `fakeTauriInvoke`):
    - `lists_the_plan_and_installs_on_click` (click **Install** → `invoke("install_agent", { agentId })`).
    - `shows_progress_from_events` (emit a download event with `receivedBytes: 512, totalBytes: 1024` → progressbar value 50%).
    - `cancel_calls_cancel_agent_install_and_returns_to_install`.
    - `a_failure_shows_the_message_and_retry_installs_again`.
    - `a_not_ready_agent_in_use_is_offered_in_the_picker_and_shows_the_panel` (App-level: fixture agent `availability: 'needs_runtime'`, enabled; picking it shows `Install {name}`, the composer's send is disabled, and no `acp_probe_agent` call is made).

- [ ] **Step 2: Run** `pnpm vitest run src/test/agent-install.test.tsx src/test/install-plan.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `App.tsx`: picker options from `agentsInUse.filter(a => a.source === 'registry' || a.detected)` with label `{name} (not installed)` when not ready; `newSessionAgentId` looks the pick up in that same list; pass `agent: isActiveRunning || draftAgent?.availability !== 'ready' ? undefined : draftAgent` to `useDraftAgentCheck`; render `<AgentInstallPanel agent={draftAgent} />` next to `AuthPanel` when `!isActiveRunning && draftAgent?.install_plan` and the window is not a popout (`lib/window-mode.ts`); disable sending while the draft agent is not ready. Keep the App.tsx change to wiring; logic lives in the hook, panel and `install-plan.ts`. Add `install_agent`, `cancel_agent_install` defaults to `fakeTauriInvoke`.

- [ ] **Step 4: Run** `pnpm lint && pnpm test`. Expected: PASS (including `design-tokens.test.ts` and `theme-contrast.test.ts`).

- [ ] **Step 5: Commit**
```bash
git add src/hooks/useAgentInstall.ts src/components/AgentInstallPanel.tsx src/lib/install-plan.ts src/App.tsx src/test/setup.ts src/test/agent-install.test.tsx src/test/install-plan.test.ts
git commit -m "feat: install a missing agent from the new-session draft"
```

### Task 12: Privacy text, troubleshooting and changelog

**Files:**
- Modify: `README.md` (*Privacy and your data*, *Troubleshooting*), `site/components/sections/Privacy.tsx`, `CHANGELOG.md`

- [ ] **Step 1: README privacy.** Replace the "One host of its own" bullet with the spec's *Privacy text* list: the registry CDN; registry download URLs and the HTTPS hosts they redirect to (e.g. `release-assets.githubusercontent.com`) when you install a binary agent; `nodejs.org` when an agent needs Node.js and yours is missing or older than 22; `uv`'s releases on GitHub when you install a `uvx` agent without `uvx`. Then: each download is checked against a SHA-256 hash before it is used; only when you click **Install**; no telemetry and no requests from the window; `npm`/`npx` fetch from the npm registry and `uvx` can download Python and PyPI packages.

- [ ] **Step 2: README troubleshooting.** "An agent shows as not installed" → choose it in a new session and click **Install**; Zorvo brings Node.js or `uv` if needed. "Claude Code, Codex or Qwen Code does not start" → drop "They need `npx` (Node.js 22+)" in favor of "Zorvo installs Node.js for them when yours is missing or older than 22".

- [ ] **Step 3: Site.** In `Privacy.tsx` retitle the second promise "Few hosts, all named" with a one-sentence body: registry, the agent's own download (hash-checked), Node.js and uv only when you install, no telemetry, no requests from the window. Run `pnpm --dir site lint` if the site has it; otherwise `pnpm lint`.

- [ ] **Step 4: Changelog.** Under `Unreleased` → `Added`: "**Install agents from Zorvo.** Choose an agent that is not installed and click **Install**. Zorvo downloads it, and Node.js or uv when you need them, and checks every download against its SHA-256 hash."

- [ ] **Step 5: Commit**
```bash
git add README.md site/components/sections/Privacy.tsx CHANGELOG.md
git commit -m "docs: list the hosts the installer contacts"
```

### Task 13: Full verification

- [ ] **Step 1:** `pnpm lint && pnpm test && pnpm build`, then from `src-tauri/`: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`. Expected: all green.
- [ ] **Step 2: Manual, debug build (`pnpm tauri dev`).** With Node hidden from the login shell (`env PATH=…` does not work: `env_resolver` reads the login shell's `PATH`; use a separate macOS user without Node, or temporarily move your Node shims aside, e.g. rename `~/.nvm` or Homebrew's `node`), pick Gemini CLI (enable it in `state.json` → `settings.enabledAgents` until sub-project 4), **Install**, start a session. Then enable OpenCode (zip) and Goose (`.tar.bz2`), install each, start a session with each. Quit mid-download once and confirm `tools/staging/` is empty after restart.
- [ ] **Step 3:** Record results in the PR description (what was run, what was not).
