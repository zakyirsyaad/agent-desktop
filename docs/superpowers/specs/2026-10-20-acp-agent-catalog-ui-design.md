# ACP agent catalog UI — design

Date: 2026-10-20
Branch: `feat/acp-agent-catalog-ui`
Sub-project 4 of 5 in "every ACP agent, set up inside Zorvo"

## Goal

The user sees every agent in the ACP registry inside Zorvo, searches it, and
adds, updates and removes agents without a terminal. This sub-project is
also the release gate: until **Update** exists, recorded agent versions stay
frozen, so no release ships before it lands.

Builds on sub-project 1 (registry catalog, `src-tauri/src/registry/`),
sub-project 2 (installer, `src-tauri/src/installer/`) and sub-project 3
(terminal sign-in). Sub-project 5 (removing Oh-My-Pi, Aider and the
terminal-session engine) runs at the same time and is not part of this work.

## Decisions

| Topic | Decision |
|---|---|
| Where the catalog lives | Settings becomes a wider dialog with two tabs, **General** and **Agents** |
| Logos | The backend downloads registry icons from the registry CDN, caches them, and also bundles them with each release |
| `npx` agents found as global npm packages | Update applies: what runs is the registry's pinned package through `npx`. Only binary agents on `PATH` are used as they are and never updated by Zorvo |
| Saved sessions of a removed agent | Readable; the composer is replaced by a panel with **Add** |
| Update discoverability | A dot on the Settings button, a count on the Agents tab, and a notice once per new version |
| Onboarding | The Agents step uses the same catalog list; copy-paste install commands go |
| Backend shape | A separate catalog read model (`get_agent_catalog`); `get_agent_profiles` stays the runtime contract |

## Constraints

- The webview sends only an agent id. The backend rebuilds versions, plans
  and downloads from the registry.
- Commands that touch the filesystem, the network or a child process are
  `#[tauri::command(async)]`.
- The webview makes no network requests; the CSP does not change.
- The main window stays the single writer of `state.json`.
- Versions change only on **Update**.
- Design-system rules: tokens only, `ui/` primitives, `focus-ring`,
  sentence-case copy that names the agents.
- Source files stay under 800 lines; `App.tsx` does not grow (new logic goes
  into hooks and `lib/` helpers).

## Backend

### Entries not available for this Mac

`schema.rs` drops a binary entry today when it has no target for this Mac's
platform. It now keeps such an entry as **catalog-only**. When this Mac's
target exists, the existing rules apply in full (https archive, 64-hex
`sha256`, safe `cmd`, safe env); a broken target still drops the entry.

`resolve.rs` gains the availability `unsupported` for a binary entry without
this Mac's target. An unsupported entry:

- is left out of `get_agent_profiles` (`Catalog::profiles` skips it);
- has no install plan;
- fails to launch with "<Agent> is not available for this Mac".

The bundled history and `pnpm registry:update` keep every entry as listed;
filtering by platform happens at run time.

### Recorded versions must be old enough

`CatalogState::entry_for` uses the version recorded in
`settings.agentVersions` only when the history has it, the registry has not
withdrawn it, **and it was first seen at least 7 days ago**. Otherwise it
falls back as today (offered version, or the recorded one when nothing is
offered and it is merely withdrawn). Every legitimately recorded version was
the offered one when it was recorded, so this never changes a real user's
agent; it stops anything that writes settings from jumping ahead of the
7-day wait.

### Catalog read model

New file `src-tauri/src/registry/catalog_view.rs` and command
`get_agent_catalog()` (async). It reads `agentVersions` from the store and
returns:

```text
AgentCatalog {
  lastChecked: number | null      // unix seconds of the last successful fetch
  agents: CatalogAgent[]          // one per id in the history
}

CatalogAgent {
  id, name, description, distribution ("npx" | "uvx" | "binary"), listed
  version: string | null          // in use, or the one that would be used; null when waiting
  updateVersion: string | null    // see Update
  status: "by_zorvo" | "on_your_mac" | "ready" | "not_installed" | "unsupported" | "waiting"
  availableFrom: number | null    // unix seconds, for "waiting"
  location: string | null         // the user's own binary on PATH
}
```

Statuses, computed from the same `Resolution` the profiles use:

| Status | When |
|---|---|
| `by_zorvo` | A binary agent running from Zorvo's tools dir, or an `npx`/`uvx` agent running on Zorvo's private Node or uv |
| `on_your_mac` | A binary agent found on `PATH` (outside Apple's system tool dirs), or an `npx` agent whose package is installed globally |
| `ready` | An `npx`/`uvx` agent that runs with the user's own runtime and needs nothing installed |
| `not_installed` | Anything Add would install: a binary not found, a missing runtime, a missing prerequisite |
| `unsupported` | A binary agent with no target for this Mac |
| `waiting` | No version listed for 7 days yet; `availableFrom` is when the oldest one will be |

Whether an agent is **in use** is not in the read model: it comes from
`settings.enabledAgents`, which the webview owns.

### Update

`updateVersion` is the offered version (newest, at least 7 days old, not
withdrawn) when it is newer than `version`. It is `null`:

- when no newer version is offered;
- for a binary agent the user installed on `PATH`: Zorvo runs it as it is
  and says it is managed outside Zorvo.

New command `update_agent(agentId)` (async):

1. Canonicalises the id and reads `agentVersions` from the store.
2. Computes the target the same way as `updateVersion`; fails with
   "No newer version of <Agent> is offered" when there is none, and with
   "<Agent> is managed outside Zorvo" for a user binary.
3. When the agent at the target version needs an install (a Zorvo-managed
   binary, a prerequisite), runs it as the install job named by the agent id,
   planned from `agentVersions` with the id moved to the target. Progress goes
   out on `agent-install-progress` and `cancel_agent_install(agentId)` stops
   it, exactly like `install_agent`. `agent-profiles-changed` follows however
   it ended.
4. Returns the target version.

The UI then records the version in `settings.agentVersions`, saves state at
once (a new `saveNow` from `usePersistedState`, skipping the debounce), and
reloads the profiles and the catalog. A failed or cancelled update leaves
the old version in use. Sessions already running keep their version until
they restart. The old Zorvo-managed copy is deleted by the existing clean-up
at the next start, which already keeps only the version in use and skips
dirs a session runs from.

`update_agent` never takes a version from the webview, and `entry_for`
refuses versions under 7 days old, so the version a session runs is always
one the backend chose.

### Icons

New file `src-tauri/src/registry/icons.rs`.

- After every successful registry refresh, on the same background thread,
  the backend downloads each listed entry's `icon` when:
  - the URL is `https://cdn.agentclientprotocol.com/...` (any other host or
    scheme is skipped);
  - the URL or the agent's listed version changed since the cached copy,
    or there is no cached copy.
- Each download: 10-second timeout, 64 KB cap, no redirect to another host,
  and the body (after an optional XML prolog and whitespace) must start with
  `<svg`. Otherwise the icon is skipped and the old copy kept.
- Cached under the app data dir as `icons/<id>.svg` plus `icons/index.json`
  (`{id: {url, version}}`), written atomically.
- `pnpm registry:update` also writes `src-tauri/resources/registry-icons.json`
  (`{id: svg}`), compiled in with `include_str!`, used for any id without a
  cached copy.
- `get_agent_icons()` (async) returns `{id: "data:image/svg+xml;base64,..."}`.
- When a refresh changed any icon, the backend emits `agent-profiles-changed`.

The UI never puts an icon's markup in the DOM. Registry icons are
monochrome `currentColor` SVGs, so they render as a CSS `mask-image`
filled with a theme token, which follows light and dark mode. The CSP
already allows `data:` images.

### Remove

No new command. The UI disables the agent and calls the existing
`remove_agent_install(agentId)`, which stops a running install, deletes only
Zorvo's copy and the prerequisites no other enabled agent needs, and defers
the deletion while a session runs from it.

### Commands added

| Command | Async | Webview sends |
|---|---|---|
| `get_agent_catalog` | yes | nothing |
| `get_agent_icons` | yes | nothing |
| `update_agent` | yes | `agentId` |

All registered in `lib.rs`'s `generate_handler!` and faked in
`src/test/setup.ts`.

## Frontend

### Settings with tabs

`SettingsPanel` grows to `max-w-2xl` and gets two tabs (a tablist with
arrow-key navigation):

- **General**: Appearance, Default agent, Recent folders, Run setup again.
- **Agents**: the catalog. The tab label shows a count when in-use agents
  have updates ("Agents 2").

The panel can open on a given tab (`initialTab`), used by the update notice.

### Catalog

`components/agents/AgentCatalog.tsx` (list, search, sections) and
`components/agents/AgentCatalogRow.tsx` (one agent). Pure logic in
`lib/agent-catalog.ts`; data in `hooks/useAgentCatalog.ts`, which calls
`get_agent_catalog`, reloads on `agent-profiles-changed` and after
**Check again**.

Header: a search field (matches name, id and description, case-insensitive),
**Check again** (moved from General; refreshes profiles and the catalog), and
"Registry checked 2 hours ago" from `lastChecked`.

Sections:

1. **In use (n)**: agents with an update first, then by name.
2. **All agents (n)**: installed (`by_zorvo`, `on_your_mac`) first, then by
   name; `waiting` and `unsupported` last.

A search with no match shows "No agents match "<query>"."

Each row: logo, name, version, a status line, a two-line description, and
the actions:

| Status | Status line | Actions when not in use | Actions when in use |
|---|---|---|---|
| `by_zorvo` | Installed by Zorvo | Add | Update, Remove |
| `on_your_mac`, binary | Managed outside Zorvo · `<location>` | Add | Remove |
| `on_your_mac`, npm global | Installed on your Mac | Add | Update, Remove |
| `ready` | Runs with npx / Runs with uvx | Add | Update, Remove |
| `not_installed` | Not installed · "Add installs <plan>" (`describePlan`) | Add | Remove (and the install panel's Retry) |
| `waiting` | Available from <date> | — | Remove |
| `unsupported` | Not available for this Mac | — | Remove |

An agent no longer listed in the registry also shows "No longer listed" and
keeps working. Update shows only when `updateVersion` is set, as
"Update to <version>".

### Add

1. `enabledAgents` gains the id (written out in full, as `withAutoEnabled`
   does) and `removedAgents` loses it.
2. When the agent's profile is not `ready`, the row starts
   `startInstall(id)` from `lib/agent-installs.ts`, with the progress bar and
   Cancel in the row (`InstallProgressLine` moves out of
   `AgentInstallPanel` into its own file so both use it). A failed install
   leaves the agent enabled and shows "Install failed: <error>" with Retry,
   like the draft panel.

`withAutoEnabled` records the agent's version on the next profile load, as
for any enabled agent.

### Update

`lib/agent-installs.ts` gains `startUpdate(agentId, onUpdated)`: the same
entry, attempt and progress handling as `startInstall`, calling
`update_agent` instead of `install_agent`, and `onUpdated(version)` on
success. `useAgentInstall` exposes `update`. The `onUpdated` callback records
`agentVersions[id]`, calls `saveNow`, then reloads profiles and catalog.

### Remove

Remove asks in the row, without a nested dialog: "Remove <Agent>? Zorvo
deletes its copy. Saved sessions stay readable." When the agent has running
sessions it adds "Its open sessions stop." On confirm:

1. the running sessions of that agent are stopped, through the session
   engine's existing stop path;
2. `enabledAgents` loses the id, `removedAgents` gains it, and
   `defaultAgentId` is cleared when it was this agent;
3. `remove_agent_install(id)` runs. A failure keeps the agent disabled and
   shows "Could not delete Zorvo's copy: <error>" in the row; the clean-up
   at the next start tries again.

### Saved sessions of a removed agent

When a session's agent is not in use, `RemovedAgentPanel` replaces the
composer: "<Agent> was removed. Add it again to continue this session." with
**Add <Agent>**, which runs the same Add. The transcript renders as before.
In a popout window the button forwards the action to the main window through
`lib/popout-bridge.ts`.

### Logos

`lib/agent-icons.ts` is a module-level store loaded once through
`get_agent_icons` and reloaded on `agent-profiles-changed`;
`useAgentIcon(id)` reads it. `AgentLogo` uses, in order: the three bundled
official logos (Claude, Codex, Qwen), the registry icon as a masked
`<span role="img">` filled with `bg-fg-muted`, then the generic `Bot` icon.
The sidebar, the agent picker and the catalog all get registry logos this
way.

### Update badge and notice

- `ProfileFooter`'s Settings button shows a dot when any in-use agent has
  `updateVersion`; its label becomes "Settings, <n> updates".
- `components/UpdateNotice.tsx` shows "<Agent> <version> is available." or
  "<n> agent updates are available." with **Show** (opens Settings on the
  Agents tab) and **Dismiss**.
- It appears once per version: Show or Dismiss records
  `settings.notifiedUpdates[id] = updateVersion` for each agent it named.
  A later version shows it again.
- `notifiedUpdates` is a new optional `Settings` field, normalised in
  `lib/persistence.ts` like `agentVersions` (ids and versions are strings;
  anything else is dropped). No `STATE_VERSION` change.
- The logic lives in `hooks/useAgentUpdates.ts`, not `App.tsx`.

### Onboarding

The Agents step renders `AgentCatalog`, so a new user can search, add and
install agents there. `installHintFor` and the copy-paste rows are removed
with their tests.

## Error handling

| Case | Behaviour |
|---|---|
| `get_agent_catalog` fails | The Agents tab shows "Could not load the agents: <error>" with Try again |
| An icon download fails or is not SVG | Logged; the bundled icon or the generic icon is used |
| `update_agent` with nothing newer | "No newer version of <Agent> is offered"; the catalog reloads |
| Update fails or is cancelled | The old version stays; "Update failed: <error>" with Retry, or back to the Update button |
| `remove_agent_install` fails | The agent stays disabled; the row shows the error; start-up clean-up retries |
| Remove during an install | The backend stops the job first (`stop_if_running`) |
| Launching an unsupported agent | Refused with "<Agent> is not available for this Mac" |

## Testing

Test-first throughout.

Rust, unit:

- `schema`: a binary entry without this Mac's target is kept; a broken
  target for this Mac still drops it.
- `resolve`/`Catalog::profiles`: unsupported entries are not profiles;
  launching one gives the right message.
- `entry_for`: a recorded version first seen 6 days ago is not used; 7 days
  is.
- `catalog_view`: every status; `updateVersion` only when newer, never a
  withdrawn or too-new version, `null` for a binary on `PATH`;
  `availableFrom` for `waiting`.
- `update_agent` target computation and refusals (pure function, tested
  without Tauri).
- `icons`: host and scheme filter, size cap, SVG check, no re-download when
  URL and version are unchanged, bundled fallback, data URL encoding.

Rust, integration (never the real network):

- an icon refresh with an injected fetch succeeds and is cached; another
  host, a fetch error (oversized body, redirect, timeout) and a non-SVG body
  each keep the old copy. Icons are fetched with `fetch_registry`, whose
  timeout, size cap and no-redirect rule already have local-HTTP-server
  integration tests.

Frontend (Vitest):

- `lib/agent-catalog`: sorting, search, status lines, actions per status,
  immutable settings updaters for Add and Remove.
- `AgentCatalog`: Add enables and installs; Update records the version,
  saves at once and reloads; Remove confirms, updates settings and calls
  `remove_agent_install`; Check again; empty search; load error.
- `UpdateNotice`/`useAgentUpdates`: once per version, Show opens the Agents
  tab, badge and tab count.
- `RemovedAgentPanel` replaces the composer for a removed agent's session.
- `AgentLogo`: bundled logo, masked registry icon, generic fallback.
- Onboarding's Agents step renders the catalog.
- `persistence`: `notifiedUpdates` normalisation.
- Design-token, contrast and design-system doc tests stay green.

Gates: `pnpm lint`, `pnpm test`, `cargo fmt --check`,
`cargo clippy --all-targets -- -D warnings`, `cargo test`.

## Docs

- `CHANGELOG.md`: a line under Unreleased.
- `CLAUDE.md`: the catalog read model, `update_agent`, icons, and the rule
  that versions change only through `update_agent`.
- README privacy section: icons come from the registry CDN, which is already
  listed.

## Out of scope

- Removing Oh-My-Pi, Aider and the terminal-session engine (sub-project 5).
- "Update all", choosing an older version, or pinning a version by hand.
- Updating agents the user installed on `PATH`.
