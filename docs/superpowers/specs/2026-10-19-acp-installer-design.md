# ACP agent installer — design

Date: 2026-10-19
Builds on: `feat/acp-registry-catalog` (sub-project 1)
Sub-project 2 of 5 in "every ACP agent, set up inside Zorvo"

## Goal

An agent that sub-project 1 reports as `needs_runtime` or `not_installed`
can be installed from inside Zorvo with one click, without a terminal.
Zorvo brings its own Node.js and `uv` when the user has none it can use,
downloads binary agents from the URLs the registry lists, checks every
download against a SHA-256 known before the download starts, and installs
the extra tools an agent needs that the registry cannot express (for
example `pi` for `pi-acp`). Progress and errors appear in the UI.

The full catalog page is sub-project 4. This sub-project ships the backend,
the interface sub-project 4 will call, and the smallest UI that makes the
feature usable: an install panel in the new-session draft.

## Decisions

| Topic | Decision |
|---|---|
| Node.js for `npx` agents | The user's own `node`/`npx` when its major version is at least 22; otherwise Zorvo's own Node |
| `uv` for `uvx` agents | The user's own `uvx`, any version; otherwise Zorvo's own `uv` |
| Binary agents | A `cmd` found on `PATH` is used as it is; otherwise Zorvo's own copy |
| Runtime versions and hashes | Pinned in Zorvo's source (`src-tauri/resources/runtimes.json`), filled by `pnpm runtimes:update` from releases at least 7 days old; runtimes change version with Zorvo releases |
| When installs happen | Only when the user clicks **Install**; nothing is downloaded without a click |
| Disk use | Only the version in use is kept, for each agent and each runtime |
| A failed or interrupted download | Staging is deleted; the user sees the error and a **Retry** that starts over; no resume |
| Archives | Unpacked in Rust (`flate2` + `tar`, `bzip2`, `zip`) with every entry checked |
| Macs | Apple silicon and Intel (`darwin-aarch64`, `darwin-x86_64`); Zorvo's release is already universal |

Decisions carried over from sub-project 1: network access only to the ACP
registry CDN, download URLs listed in the registry, `nodejs.org` and `uv`'s
official releases; a version is offered only after 7 days; the webview CSP
does not change and all network access is in the Rust backend; `ureq`
3.4.2 with rustls.

## Constraints

- The webview never chooses what is downloaded or run. It sends an agent id;
  the backend takes URLs, hashes and versions from `runtimes.json`, the
  prerequisite table or a validated registry entry.
- No secrets are asked for or stored.
- Commands that touch the network, the filesystem or a child process are
  `#[tauri::command(async)]`.
- Test-first; `pnpm lint`, `pnpm test`, `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings` and `cargo test` green.
- Source files stay under 800 lines.

## What the registry holds

On 2026-10-19, for macOS:

| Archive format | `darwin-aarch64` | `darwin-x86_64` |
|---|---|---|
| `.tar.gz` | 14 | 13 |
| `.zip` | 4 | 4 |
| `.tar.bz2` | 1 (Goose) | 1 |

Kimi has no Intel build; sub-project 1 already skips an entry with no
target for this Mac, so on an Intel Mac Kimi is not offered at all.
Junie's zip holds a `.app` bundle, whose symlinks must survive unpacking.
27 of the 37 macOS archive URLs are on `github.com`, which redirects to
`release-assets.githubusercontent.com`. The others are on
`dl.google.com`, `downloads.cursor.com`, `static.devin.ai`,
`downloads.poolside.ai` and `sfc-repo.snowflakecomputing.com`.

## Architecture

A new backend module, `src-tauri/src/installer/`:

| File | Purpose |
|---|---|
| `runtimes.rs` | Parses `resources/runtimes.json` (compiled in with `include_str!`); finds the user's Node and checks its version; chooses which Node and `uv` an agent runs with. |
| `download.rs` | Streams one URL to a file with `ureq`, hashing with `sha2` as it writes; size cap, timeouts, HTTPS-only redirects, cancellation. |
| `archive.rs` | Unpacks `.tar.gz`, `.tar.bz2` and `.zip` into a directory, checking every entry. |
| `prerequisites.rs` | The static table of per-agent prerequisites and their npm install. |
| `layout.rs` | Paths under the app data directory, staging directories, the final atomic rename, and clean-up at start. |
| `mod.rs` | The install plan, the per-target locks, running a plan step by step, progress. |
| `commands.rs` | The Tauri commands and the progress event. |

New crates: `sha2`, `flate2`, `tar`, `bzip2` (with its pure-Rust backend),
`zip` (deflate only, no other features).

`registry/resolve.rs` gains the installer's view of the machine (chosen
runtimes, installed agents, installed prerequisites) through `SystemTools`,
and fills the new `install_plan` field. `acp/commands.rs::launch_for` takes
the program path and the `PATH` changes from the resolved profile.

## On disk

Under `~/Library/Application Support/xyz.zorvo.desktop/`:

```
tools/
  node/<version>-<arch>/          Zorvo's Node.js
  uv/<version>-<arch>/            Zorvo's uv and uvx
  agents/<agent-id>/<version>/    an unpacked binary agent
  prereqs/<name>/<version>/       an npm prefix holding a prerequisite
  staging/<random>/               an install in progress
```

`<arch>` is the registry's platform key (`darwin-aarch64`,
`darwin-x86_64`). A directory outside `staging/` exists only when its
install finished: every install downloads, verifies and unpacks inside
`staging/`, writes an `install.json` (source URL, SHA-256, time), and then
moves the result into place with one `rename`. The layout itself is the
record of what is installed; there is no separate manifest.

## Runtimes

### `runtimes.json`

```json
{
  "node": {
    "version": "24.11.1",
    "released": "2026-…",
    "targets": {
      "darwin-aarch64": {
        "url": "https://nodejs.org/dist/v24.11.1/node-v24.11.1-darwin-arm64.tar.gz",
        "sha256": "…",
        "size": 51234567,
        "bin": "node-v24.11.1-darwin-arm64/bin"
      },
      "darwin-x86_64": { "…": "…" }
    }
  },
  "uv": { "version": "…", "released": "…", "targets": { "…": "…" } }
}
```

(The values above show the shape only; `pnpm runtimes:update` writes the
real ones.)

At start the backend rejects the file (and installs no runtime) when a URL
is not `https://nodejs.org/dist/…` for Node or
`https://github.com/astral-sh/uv/releases/download/…` for `uv`, when a
`sha256` is not 64 hex digits, or when `bin` is absolute or contains `..`.
A test checks the committed file passes.

### `pnpm runtimes:update`

A script in `scripts/`, run by a maintainer and committed:

- Node: the newest LTS release in `https://nodejs.org/dist/index.json`
  whose release date is at least 7 days ago. Hashes come from that
  release's `SHASUMS256.txt`.
- `uv`: the newest release on GitHub whose `published_at` is at least
  7 days ago. Hashes come from each asset's `.sha256` file.
- For each target it downloads the archive and checks that its hash and
  size match what it records. It never records a release younger than
  7 days.

### Choosing a runtime

- **Node.** When the user environment is read (at start and on
  `get_agent_profiles(refresh: true)`), the backend runs the user's
  `node --version` with a 5-second timeout, as it runs `npm ls -g`. A
  version with major 22 or higher makes the user's Node the one used, and
  the agent's `PATH` is left alone. Otherwise, when Zorvo's Node is
  installed, it is used: the program is Zorvo's `npx` by absolute path and
  Zorvo's Node `bin` directory is put **first** in the agent's `PATH`, so a
  `#!/usr/bin/env node` script cannot pick up an older Node of the user's.
- **uv.** A `uvx` on the user's `PATH` is used as it is. Otherwise Zorvo's
  `uvx` by absolute path, with its directory appended to the agent's
  `PATH`. `uv` downloads Python and PyPI packages itself when it needs
  them, into its usual places in the home directory.
- **A new pinned version.** When a Zorvo release pins a newer runtime, the
  installed older one keeps being used, so no agent turns into "needs
  install". The pinned version is installed by the next **Install** whose
  plan needs that runtime, or by `install_runtime` (see Interfaces), which
  sub-project 4's Settings page calls to offer a runtime update. Clean-up
  removes the older one once the pinned one is installed.

## Binary agents

The resolver looks for a binary agent's command in this order:

1. its `cmd` basename on the user's `PATH` (as in sub-project 1);
2. Zorvo's copy, `tools/agents/<id>/<version>/<cmd>`, where `<version>` is
   the version in use (`settings.agentVersions[id]`, else the offered one,
   exactly as sub-project 1 resolves the entry);
3. otherwise `not_installed`.

Zorvo's copy runs by absolute path.

Updating a Zorvo-installed binary agent (the **Update** button,
sub-project 4) installs the new version next to the old one; the UI then
records the new version in `settings.agentVersions`. The old version is
removed at the next start.

## Prerequisites

`prerequisites.rs` declares, per agent id, the tools the agent runs that
its registry entry does not install:

| Agent | Command | npm package |
|---|---|---|
| `pi-acp` | `pi` | `@earendil-works/pi-coding-agent@<exact version>` |

The exact version is the newest one published at least 7 days before the
change that sets it, the same rule as the registry; raising it is a code
change.

- A prerequisite whose command is on the user's `PATH` is satisfied as it
  is.
- Otherwise the installer runs, with the chosen Node first on `PATH`:
  `npm install -g --prefix <staging> --no-audit --no-fund <package>@<version>`,
  as an argument vector, with a 10-minute timeout. npm checks the package
  against the `integrity` hash the npm registry publishes, as it does for
  `npx`. The prefix moves to `tools/prereqs/<command>/<version>/`.
- At launch, each installed prerequisite's `bin` directory is appended to
  the agent's `PATH`.
- An `npx` agent with its runtime ready but a prerequisite missing is
  `not_installed`; its launch error names the missing command.

## Availability and the install plan

`availability` keeps its three values from sub-project 1. `ready` now also
counts Zorvo's runtimes, Zorvo's agent copies and Zorvo's prerequisites.

Each `AgentProfile` gains:

| Field | Type | Meaning |
|---|---|---|
| `install_plan` | `InstallStep[]` or null | What **Install** would do; null when `ready` |

```ts
type InstallStep = {
  kind: "node" | "uv" | "agent" | "prerequisite";
  name: string;            // "Node.js", "uv", the agent's name, "pi"
  version: string;
  download_bytes: number | null; // from runtimes.json; null for agents and prerequisites
};
```

Steps are ordered: runtime, then prerequisites, then the agent's archive.
A `node` or `uv` step appears when the agent needs that runtime and the
user's own is not usable, and Zorvo's pinned version is not installed yet.
The plan is computed from local state only; it makes no network request.

## Interfaces

### Commands

| Command | Behavior |
|---|---|
| `install_agent(agent_id)` | Resolves the profile, recomputes its plan and runs the steps in order. Resolves when the agent is installed; rejects with a readable message, or `INSTALL_CANCELLED` when cancelled. On success the backend emits `agent-profiles-changed`. Rejects when the id is unknown, the agent is already `ready`, or an install of the same agent is running. |
| `cancel_agent_install(agent_id)` | Sets the install's cancel flag. The download stops at its next chunk and staging is deleted. No-op when nothing is running. |
| `install_runtime(kind)` | `kind` is `"node"` or `"uv"`. Installs the pinned version when it is not installed; resolves at once when it is. Same errors, cancellation (`cancel_agent_install` with the id `runtime:<kind>`) and progress event (with `agentId` set to `runtime:<kind>`). For sub-project 4's runtime update. |
| `remove_agent_install(agent_id)` | For sub-project 4. Deletes Zorvo's copy of the agent and the prerequisites no other enabled agent needs; never anything outside `tools/`. While a session of the agent is running, the deletion waits until the next start. |

### Event `agent-install-progress`

```ts
{
  agentId: string;
  stepIndex: number;
  stepCount: number;
  kind: "node" | "uv" | "agent" | "prerequisite";
  name: string;
  phase: "download" | "verify" | "unpack" | "npm";
  receivedBytes: number;
  totalBytes: number | null; // from Content-Length, else runtimes.json
}
```

Emitted at most every 250 ms per install, and once at each phase change.

### Concurrency

Each target has its own lock: `node`, `uv`, `agent:<id>`, `prereq:<name>`.
A step takes its target's lock, then checks again whether the target is
installed, so two agents that both need Node download it once: the second
waits and finds it there. Installs of different agents otherwise run in
parallel.

### UI in this sub-project

- `src/hooks/useAgentInstall.ts`: per agent, `idle | installing (progress) |
  failed (error)`; calls the commands and listens to the event.
- `src/components/AgentInstallPanel.tsx`: shown in the new-session draft,
  where the sign-in panel appears, when the chosen agent is not `ready`.
  It lists the plan ("Node.js 24.11.1 (49 MB) and OpenCode 1.19.3"), then
  shows **Install**; while installing, a progress bar per step and
  **Cancel**; on failure, the message and **Retry**.
- After a successful install the profiles reload, and the existing sign-in
  check (`useDraftAgentCheck`) runs as for any ready agent.
- Popout windows never install.
- Sub-project 4 reuses the hook and the panel in the catalog.

UI copy follows the design-system rules: sentence case, short sentences,
agents named rather than "AI".

## Downloads

- Only URLs from `runtimes.json` or a validated registry entry. The
  registry rule from sub-project 1 (an `https` archive URL and a 64-digit
  `sha256`) still applies.
- HTTPS only, for the first request and for every redirect; at most 5
  redirects. Redirects may change host (GitHub sends every release
  download to `release-assets.githubusercontent.com`); the hash, known
  before the request, is what makes the content trustworthy.
- Timeouts: 30 seconds to connect and to receive the response headers;
  the download fails when no data arrives for 60 seconds. No overall
  timeout, so a large archive on a slow line can finish.
- At most 1 GiB per download; a larger `Content-Length` fails at once, and
  a body that grows past it fails when it does.
- The SHA-256 is computed while the file is written and compared before
  anything is unpacked.
- Cancellation is a flag checked between chunks.

The download function takes the HTTPS rule as a parameter so the
integration tests can use a local `http://127.0.0.1` server; production
code always passes HTTPS-only.

## Unpacking

`archive.rs` picks the format from the URL's ending (`.tar.gz`, `.tgz`,
`.tar.bz2`, `.zip`); any other ending fails the install with "Zorvo cannot
unpack this archive format".

An entry fails the whole install when:

- its path is absolute, or has a `..` component;
- it is a symlink whose target, resolved from the link's directory, lands
  outside the destination;
- it is a hard link, a device file or a FIFO;
- the unpacked total passes 4 GiB, or the archive has more than 200,000
  entries.

Kept: regular files with their executable bit, directories, and symlinks
that stay inside the destination (Node's `bin/npx` points into `lib/`;
`.app` bundles hold framework symlinks).

After unpacking an agent, its `cmd` must exist inside the destination as
a regular file. When it lacks the executable bit (common in zips), the
installer sets it on that one file. Downloads carry no quarantine
attribute (`ureq` does not set one), so Gatekeeper does not prompt;
Zorvo does not add or remove extended attributes.

## Clean-up at start

In the background, after the catalog loads:

- delete everything in `tools/staging/`;
- delete `tools/agents/<id>/<version>/` when the agent is not enabled, or
  `<version>` is not the version the resolver uses for it (the one in
  `settings.agentVersions[id]`, else the offered one);
- delete a runtime version that is not the pinned one, once the pinned one
  is installed;
- delete Zorvo's Node or `uv` entirely when no enabled agent uses `npx`
  (respectively `uvx`);
- delete a prerequisite no enabled agent needs.

Failures are logged and ignored; clean-up never blocks start.

## Error handling

| Case | Behavior |
|---|---|
| Offline, DNS, TLS or HTTP error | "Could not download X from <host> (<status or reason>)"; **Retry** |
| No data for 60 seconds | "The download of X stalled"; **Retry** |
| Download larger than 1 GiB | "X is larger than Zorvo allows (1 GiB)" |
| Hash mismatch | "The download of X did not match its checksum"; nothing installed |
| An unsafe entry in the archive | "X's archive contains a file Zorvo will not unpack: <path>"; nothing installed |
| `cmd` missing after unpacking | "X's archive does not contain <cmd>"; nothing installed |
| Disk full | "Not enough disk space to install X" |
| npm fails or times out | The message and the last 20 lines of npm's error output |
| Cancelled | Staging deleted; the panel returns to **Install** |
| Zorvo quits or crashes mid-install | `staging/` is emptied at the next start |

Every failure deletes its staging directory. Nothing outside `staging/`
changes until the final `rename`.

## Privacy text

`README.md` (*Privacy and your data* and *Troubleshooting*) and
`site/components/sections/Privacy.tsx` list the hosts Zorvo contacts:

- the ACP registry CDN (`cdn.agentclientprotocol.com`), to list agents;
- the download URLs listed in the registry, and the HTTPS hosts they
  redirect to (for example `release-assets.githubusercontent.com`), when
  you install a binary agent;
- `nodejs.org`, when you install an agent that needs Node.js and yours is
  missing or older than 22;
- `uv`'s releases on GitHub, when you install a `uvx` agent and have no
  `uvx`.

Each download is checked against a SHA-256 hash before it is used. Only
when you click **Install**. No telemetry, and no requests from the window.
The tools agents run make their own requests: `npm`/`npx` fetch packages
from the npm registry, and `uvx` can download Python and PyPI packages.

The troubleshooting row "An agent shows as not installed" changes to point
at **Install** in the new-session draft.

## Testing

Rust, unit:

- `archive`: one crafted archive per rejection rule, in each format;
  symlinks inside the destination and executable bits survive; the size
  and entry caps.
- `runtimes`: the committed `runtimes.json` is valid; each URL, hash and
  `bin` rule rejects; `node --version` parsing (`v22.0.0` accepted,
  `v20.18.1` not, garbage not); the choice between the user's and Zorvo's
  Node and the `PATH` it produces.
- `resolve`: binary on `PATH` beats Zorvo's copy; Zorvo's copy at the
  version in use is `ready`; another version is not; `pi-acp` without
  `pi` is `not_installed`; `install_plan` for each kind of agent.
- `layout`: clean-up removes exactly what the rules say.

Rust, integration (a local HTTP server, never the real network):

- a successful install of a binary agent and of a runtime;
- a hash mismatch, a download over the cap, a redirect to `http`, a stall,
  and a cancel mid-download each leave nothing outside `staging/` and an
  empty `staging/`;
- two installs that both need Node download it once.

Frontend:

- `useAgentInstall` and `AgentInstallPanel`: the plan is listed; progress
  updates from events; **Cancel** and **Retry**; a success reloads the
  profiles.

Script:

- `pnpm runtimes:update` never records a release younger than 7 days, and
  fails when a downloaded archive's hash does not match.

Manual, in a debug build:

- on a Mac without Node (or with `PATH` set to hide it), install Gemini
  CLI and start a session;
- install OpenCode (zip) and Goose (`.tar.bz2`) and start a session with
  each.

## Out of scope

- `terminal` sign-in methods (sub-project 3).
- The catalog page, **Update** and **Remove** buttons, registry icons
  (sub-project 4); this sub-project provides the commands they call.
- Removing Oh-My-Pi, Aider and the terminal-session engine (sub-project 5).
- Resuming a partial download, or retrying on its own.
- Verifying Node's `SHASUMS256.txt` signature with GPG; the hash pinned in
  Zorvo's source is the check at run time.
