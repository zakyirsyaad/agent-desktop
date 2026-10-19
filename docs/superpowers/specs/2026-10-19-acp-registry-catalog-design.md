# ACP registry and agent catalog — design

Date: 2026-10-19
Branch: `feat/acp-registry-catalog`
Sub-project 1 of 5 in "every ACP agent, set up inside Zorvo"

## Goal

Any agent in the official ACP registry can be used in Zorvo. The user picks
an agent, Zorvo installs it if needed, and the user signs in, all without
opening a terminal. This sub-project lays the foundation: Zorvo reads the
registry, decides which version of each agent may be used, works out
whether each agent can run on this Mac, and keeps the list of agents the
user uses. Agents already on the machine (Gemini CLI, OpenCode, Goose, …)
show up on their own.

### The five sub-projects

1. **Registry and catalog** (this document): registry fetch, dated version
   history with a 7-day wait, detection, registry-driven ACP profiles,
   legacy id migration.
2. **Installer**: Zorvo's own Node.js and `uv`, binary downloads verified by
   SHA-256, per-agent prerequisites (for example `pi` for `pi-acp`).
3. **Terminal sign-in**: advertise `clientCapabilities.auth.terminal` and run
   `terminal` auth methods in Zorvo's own terminal panel.
4. **Catalog UI**: an Agents page in Settings and onboarding to search,
   add, install, update and remove agents; registry icons.
5. **Clean-up**: remove Oh-My-Pi, Aider and the terminal-session engine.

The privacy text changes in this sub-project, the first to make network
requests.

## Decisions already made

| Topic | Decision |
|---|---|
| Source of agents | The official ACP registry, `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` |
| Network access | Only the registry CDN, download URLs listed in the registry, `nodejs.org` (sub-project 2) and `uv`'s official releases (sub-project 2), each download verified by hash |
| Version policy | A version is offered once it has been listed for at least 7 days; installed agents change version only when the user clicks **Update** |
| First run | Each release bundles a dated version history, so a new install can use versions that already passed the wait |
| Agents already installed | Used as they are: a binary agent found on `PATH` runs from there; Zorvo installs its own copy only when none is found |
| Catalog | Shows every registry agent with search; major vendors and installed agents first (sub-project 4) |
| Built-in agents | Claude Code, Codex and Qwen Code move to their registry entries; Oh-My-Pi and Aider are removed (sub-project 5); Pi comes in through `pi-acp` |

## Constraints

- The webview still never chooses what runs. It sends an agent id; the
  backend resolves program and arguments from a validated registry entry.
- The webview CSP does not change. All network access is in the Rust
  backend, never in the webview.
- No secrets are asked for or stored.
- Every path from the UI is still checked with `ensure_known_workspace`.
- Test-first; `pnpm lint`, `pnpm test`, `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings` and `cargo test` green.
- Source files stay under 800 lines.

## Registry format

The registry is a JSON object `{ version, agents, extensions }`. Each agent
has `id`, `name`, `version`, `description`, `repository`, `authors`,
`license`, `icon` and a `distribution` with exactly one of:

| Kind | Fields | How it runs |
|---|---|---|
| `npx` | `package` (`name@version`), optional `args` | `npx -y <package> <args…>` |
| `uvx` | `package`, optional `args` | `uvx <package> <args…>` |
| `binary` | per platform (`darwin-aarch64`, `darwin-x86_64`, …): `archive` URL, `cmd`, `args`, `sha256` | `<cmd> <args…>` from the unpacked archive, or the same command found on `PATH` |

On 2026-10-19 the registry held 42 agents: 23 `npx`, 19 `binary`, 2 `uvx`.

## Architecture

A new backend module, `src-tauri/src/registry/`:

| File | Purpose |
|---|---|
| `schema.rs` | Strict parsing of the registry JSON into typed entries. Rejects an entry, never the whole registry, when it breaks a rule (see Validation). |
| `history.rs` | The dated version history: when each `(agent id, version)` was first seen, merged from the bundled history and Zorvo's own observations. Picks the newest version listed for at least 7 days. |
| `fetch.rs` | Fetches the registry over HTTPS with `ureq` (rustls), from the one fixed URL, with a 10-second timeout and a 5 MB cap; refuses redirects to another host. |
| `resolve.rs` | Turns a chosen registry entry into an ACP `AgentProfile`: program, arguments, availability. |
| `mod.rs` | The cached catalog: loads the bundle and cache at start, refreshes in the background, answers `get_agent_profiles`. |

`profiles.rs` keeps the remaining terminal profiles (Oh-My-Pi, Aider) until
sub-project 5 and drops its hard-coded ACP profiles (Claude Code, Codex,
Qwen Code); `get_available_agent_profiles` merges registry profiles with the
terminal ones.

### Version history

- `src-tauri/resources/registry-history.json` is compiled into the binary
  with `include_str!`: for every agent, every version Zorvo's maintainers
  have seen, with the date it was first seen, plus the full registry entry
  of that version.
- `pnpm registry:update` (a script in `scripts/`) fetches the registry and
  adds any new `(id, version)` with today's date. It never changes the
  date of a version it already has. Its output is committed, so dates
  reflect real observations.
- At run time, Zorvo merges the bundled history with its own,
  `registry-history.json` in the app data directory, which records each
  version the first time this install sees it.
- An agent's **offered version** is the newest version first seen at least
  7 days ago. A version first seen less than 7 days ago is not offered
  yet; if none qualifies, the agent is not offered.

### Fetching

- On start, in the background, when the last successful fetch is more than
  24 hours old; and on `get_agent_profiles(refresh: true)` (the **Check
  again** button in Settings).
- When versions or availability change, the backend emits
  `agent-profiles-changed`; the UI reloads its profiles.
- The time of the last successful fetch is kept in the cache, so Settings
  can say when the registry was last updated.

## Availability and the agents in use

Each registry agent gets one availability:

| Availability | When |
|---|---|
| `ready` | It can run now: an `npx` agent with `npx` found, a `uvx` agent with `uvx` found, a binary agent whose `cmd` is on `PATH` |
| `needs_runtime` | An `npx` or `uvx` agent while Node.js or `uv` is missing (Zorvo's own runtimes come in sub-project 2) |
| `not_installed` | A binary agent not on `PATH` (Zorvo's installer comes in sub-project 2) |

Because every `npx` agent is `ready` once Node.js exists, availability alone
cannot decide what the sidebar shows. The agents the user uses are kept in
`settings.enabledAgents` in `state.json`:

1. Claude Code, Codex and Qwen Code are enabled by default, for existing
   and new users.
2. An agent found installed on the system is enabled automatically, once:
   - a binary agent whose `cmd` (for example `opencode`, `goose`) is on
     `PATH`;
   - an `npx` agent whose package (without version) is installed globally,
     read once per refresh from `npm ls -g --depth=0 --json` with the
     user's own `npm`.

   An agent the user later removes (sub-project 4) is recorded in
   `settings.removedAgents` and is not enabled again automatically.
3. Any other agent is added from the catalog (sub-project 4).

`installed_on_system` marks an agent found by step 2.

An `npx` agent always runs the registry's pinned package through `npx`;
npm's cache is its installation. Its sign-in and settings live in the
user's home directory (for example `~/.gemini`), so they are the same as
for a copy the user installed. "Use what is already installed" applies in
full to binary agents.

### Agents that leave the registry

An enabled agent whose id disappears from the registry keeps running with
the last version Zorvo knew, and is marked as no longer listed.

## Interfaces

### `get_agent_profiles(refresh)`

Same name and result type. Each `AgentProfile` gains:

| Field | Type | Meaning |
|---|---|---|
| `source` | `"registry" \| "builtin"` | Where the profile comes from |
| `version` | string or null | The offered registry version |
| `distribution` | `"npx" \| "binary" \| "uvx"` or null | How it runs |
| `availability` | `"ready" \| "needs_runtime" \| "not_installed"` | See above |
| `description` | string or null | From the registry |
| `installed_on_system` | bool | Found installed by the user |
| `listed` | bool | Still in the registry |

`detected` stays and equals `availability == "ready"`, so existing callers
keep working. With `refresh: true` the backend re-reads the login shell's
`PATH` (as today) and refetches the registry.

### Launching

`acp/commands.rs::launch_for` resolves registry profiles through
`registry::resolve`; the `AcpLaunch` it returns has the same shape as
today. A profile that is not `ready` fails with a clear error naming what
is missing.

### Legacy ids

| Old id | Registry id |
|---|---|
| `claude-code` | `claude-acp` |
| `codex` | `codex-acp` |
| `qwen` | `qwen-code` |

- `src/lib/persistence.ts` rewrites `profileId` of saved sessions,
  `settings.defaultAgentId` and the keys of `agentOptions` when the state
  loads, and saves the result.
- The backend accepts the old ids too, mapping them before lookup, so a
  popout or an in-flight call made with an old id still works.
- `AgentLogo` maps its three logos to the new ids; any other agent shows
  the generic icon until registry icons arrive (sub-project 4).

### UI in this sub-project

- The sidebar's agent list and onboarding show only enabled agents.
- Nothing else in the UI changes; the catalog page is sub-project 4.

## Validation and security

An entry is skipped, with the rest of the registry kept, when:

- its `id` does not match `^[a-z0-9][a-z0-9-]*$`;
- an `npx` or `uvx` `package` is not pinned to an exact version
  (`name@1.2.3`, scoped names allowed);
- a `binary` entry for this Mac's platform has an archive URL that is not
  `https`, or a `sha256` that is not 64 hex digits;
- its `cmd` is an absolute path or contains `..`;
- it has no `distribution`, or more than one kind.

The whole fetch is rejected, and the cached registry kept, when the
response is not JSON, is larger than 5 MB, or lacks `agents`.

- Registry arguments are passed as an argument vector, never through a
  shell.
- `ureq` only ever requests the one registry URL; a redirect to another
  host fails the fetch.

## Error handling

| Case | Behavior |
|---|---|
| Offline, HTTP error, timeout | Use the cache, or the bundle when there is no cache; no error banner; Settings shows when the registry was last updated |
| Malformed registry | Reject the fetch, keep the cache |
| Invalid entry | Skip that entry |
| No version past the 7-day wait | The agent is not offered |
| `npm ls -g` fails or `npm` is missing | Skip global-package detection; nothing else changes |
| Launching an agent that is not `ready` | Fail with a message that names what is missing |

## Privacy text

`README.md` (*Privacy and your data*) and the landing page's privacy section
change from "makes no network requests itself" to the list of hosts Zorvo
contacts and why: the ACP registry CDN, download URLs listed in the
registry (sub-project 2), `nodejs.org` and `uv`'s releases (sub-project 2).
No telemetry, and no requests from the webview.

## Testing

Rust, unit:

- `schema`: a valid registry; each invalid-entry rule skips only that entry.
- `history`: newest version past 7 days wins; a version on day 6 is not
  offered and is on day 7; bundled and local histories merge without
  changing an earlier date.
- `resolve`: `npx`, `uvx` and binary-on-`PATH` entries become the right
  program and arguments; missing runtimes and binaries give the right
  availability.
- Legacy id mapping.

Rust, integration (a local HTTP server, never the real network):

- A successful fetch updates the cache and history.
- Timeout, a response over 5 MB, malformed JSON, and a redirect to another
  host each keep the old cache.

Frontend:

- `persistence`: old ids are rewritten in sessions, the default agent and
  `agentOptions`.
- The sidebar and onboarding list only enabled agents.
- An agent reported as `installed_on_system` is enabled once; one in
  `removedAgents` is not.

Script:

- `pnpm registry:update` adds new versions with today's date and never
  rewrites an existing date.

Manual: in a debug build, an agent already installed on the Mac (for
example Gemini CLI or OpenCode) appears in the sidebar without any setup.

## Out of scope

- Installing Node.js, `uv` or binary agents (sub-project 2).
- `terminal` sign-in methods (sub-project 3).
- The catalog page, registry icons, adding and removing agents
  (sub-project 4).
- Removing Oh-My-Pi, Aider and the terminal-session engine (sub-project 5).
