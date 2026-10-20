# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Zorvo (formerly Agent Desktop) is a macOS Tauri 2 app that hosts other coding agents. Qwen Code, Claude Code, Codex and the other agents come from the ACP registry and are driven over the Agent Client Protocol (ACP, JSON-RPC over stdio) and shown as a chat UI. Pi comes through the registry's `pi-acp` adapter. A PTY is used only to run an agent's own terminal sign-in. React 19 + Tailwind 4 frontend in `src/`, Rust backend in `src-tauri/` (crate `zorvo`, lib `zorvo_lib`). Package manager is pnpm.

## Commands

```bash
pnpm install
pnpm tauri dev              # run the app (Vite on :1420 + Rust backend)
pnpm lint                   # tsc --noEmit + eslint --max-warnings=0
pnpm test                   # all Vitest tests
pnpm vitest run src/test/persistence.test.ts          # one file
pnpm vitest run src/test/persistence.test.ts -t "name" # one test
pnpm design-system          # local design-system reference on :5180
pnpm registry:update        # refresh the bundled ACP registry history (src-tauri/resources/registry-history.json)
pnpm tauri build            # production bundle (the only build that applies the CSP)
```

Rust (from `src-tauri/`; `pnpm build` must have produced `dist/` first, since Tauri embeds it at compile time):

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo test --test acp_manager_test            # one integration test file
cargo test --test acp_manager_test some_name  # one test
```

The Rust ACP tests spawn `src-tauri/tests/fixtures/fake_acp_agent.mjs` with Node, so Node must be on PATH. CI runs all of the above except `cargo fmt` (lefthook runs that pre-commit if installed with `pnpm lefthook install`).

## Architecture

**Frontend ↔ backend.** The UI calls Tauri commands (all registered in `src-tauri/src/lib.rs`'s `generate_handler!`) and listens to events: `acp-event` (one channel for every ACP session, payload `{sessionId, kind: update|permission|turn-end|exit, ...}` built in `acp/commands.rs`) and `sign-in-terminal` (output and exit of an agent's terminal sign-in, see below).

**Session engine.** Every session is an ACP chat, run by `src/hooks/session-engine/useAcpEngine.ts`. ACP updates are folded into chat messages by `src/lib/acp-events.ts`; modes/models/config options come from the agent at session start (`useAcpSessions.ts`, `lib/acp-draft.ts`). Saved terminal sessions from older versions are dropped on load (`dropTerminalSessions` in `lib/persistence.ts`).

**Agent profiles are the trust boundary.** ACP agents come from `src-tauri/src/registry/`: the official ACP registry, fetched by the Rust backend (never the webview) at startup when the last fetch is over 24 hours old and on **Check again**. It keeps a dated version history, and a version is offered only after it has been listed for 7 days. A history is bundled with each release (`pnpm registry:update` regenerates `src-tauri/resources/registry-history.json`). Agents in use are `settings.enabledAgents`, the version in use is `settings.agentVersions`, and installed agents are enabled once automatically. The webview only ever sends an agent id (and folder); `acp/commands.rs::launch_for` turns the id into a command line. Never let the UI pass a raw command or args.

**Installer** (`src-tauri/src/installer/`). Zorvo installs an agent the user picks, plus Node.js or uv when it needs them, under the app data dir's `tools/`. Runtimes are pinned with their SHA-256 in `src-tauri/resources/runtimes.json` (`pnpm runtimes:update` regenerates it); every download is checked against a pinned hash, archives unpack with path and size checks, and each install is written to `tools/staging/` and renamed into place. Commands: `install_agent`, `install_runtime`, `cancel_agent_install`, `remove_agent_install`; progress goes out as `agent-install-progress`, and `agent-profiles-changed` follows every install. The plan is rebuilt in the backend from the agent id, never taken from the UI.

**ACP backend** (`src-tauri/src/acp/`): `jsonrpc.rs` framing, `connection.rs` one agent process, `manager.rs` maps app session ids onto ACP sessions. One agent process can host several ACP sessions (a native fork lives in its source's process), so connections are shared and killed only when their last session stops. Auth-required errors are surfaced to the UI as `ACP_AUTH_REQUIRED:` + JSON (parsed in `src/lib/acp-auth.ts`), both when a session opens and when a prompt is refused (Claude Code's adapter opens sessions signed out and refuses only the prompt).

**Probing a draft's agent.** ACP agents report modes/models/efforts/slash commands only inside a session, so `acp/probe.rs` (`acp_probe_agent`) asks in a short-lived process. Opening a session can run the user's session hooks and lands in the agent's history, so it opens one only to learn a never-run agent's options or to check the sign-in of an agent that cannot report it, and deletes it in the background (`session/delete`, else `session/close`). An agent that pushes `_auth/status_update` (Claude Code) and whose options are known is only asked who is signed in. `signInChecked` in the result says whether the sign-in was actually seen. `src/hooks/useDraftAgentCheck.ts` drives it for a new-session draft (via `useAgentProbe`), keeps the sign-in panel in step and asks again on window focus while a sign-in is pending; results are merged with `withProbed` (`lib/acp-draft.ts`), which never overwrites what a real session reported.

**Terminal sign-in.** Zorvo advertises `auth.terminal`. `acp_start_terminal_sign_in` reads a `type: "terminal"` method from a fresh `initialize` (`acp/terminal_auth.rs`, same env deny list as the registry) and runs the agent's own program plus the method's args in a PTY with a `signin-` id. Its output goes on `sign-in-terminal`. `useAgentSignIn` re-checks with the probe and sends the refused message through `retryAfterSignIn`. `authenticate` is never sent for a terminal method.

**Environment.** A Finder-launched app has no shell PATH, so `env_resolver.rs` reads the user's login-shell environment once (warmed at startup) and every spawn uses it. `get_agent_profiles(refresh: true)` re-reads it.

**Persistence.** `store.rs` writes `state.json` and `transcripts/<id>.json` atomically under `~/Library/Application Support/xyz.zorvo.desktop/`. Frontend validation/normalization of loaded state is in `src/lib/persistence.ts` (`STATE_VERSION`); `data_migration.rs` copies data once from the old `com.agentdesktop.app` folder. On load the UI calls `end_orphaned_sessions`, because a webview reload leaves backend agents running that the new UI does not know.

**Path checks.** Every backend command that reads or runs in a folder from the UI must first call `files::ensure_known_workspace` (canonicalized, checked against the store's known workspaces). Follow this in any new command.

**Popout windows.** A session can open in its own window (`index.html?session=<id>&popout=1`, see `lib/window-mode.ts`). The main window is the single writer: it parses agent output and persists state; popouts only render snapshots and forward actions (`lib/popout-bridge.ts`), so two windows never write the same files.

**Fork, rewind, worktrees.** Fork uses the agent's native ACP fork when available, otherwise a handoff file (`fork_handoff.rs`, `lib/fork-handoff.ts`) the new agent is told to read. Worktree sessions get an `agent/<title>` branch under the app data dir's `worktrees/` (`worktrees.rs`). Git changes/commits are in `changes.rs` and `diff_stats.rs`; PR data comes from the user's own `gh` (`pull_requests.rs`).

**Threading rule for Tauri commands.** Commands that touch the filesystem, the login shell or a child process are `#[tauri::command(async)]` so they don't freeze the window. `send_input` stays sync so a sign-in terminal's keystrokes reach the PTY in order: async would run them on a thread pool where they could arrive out of order.

## Testing conventions

- Frontend tests live in `src/test/` (Vitest + Testing Library, jsdom). `src/test/setup.ts` fakes Tauri `invoke`, including an in-memory store seeded via `window.__FAKE_TAURI_STORE__` and canned ACP responses; agent profile fixtures are in `src/test/fixtures/agents.ts`.
- Rust tests are in `#[cfg(test)]` modules and `src-tauri/tests/`.
- Agent worktrees under `.claude/` contain copies of the repo; Vitest and ESLint both exclude `.claude/**`.

## Design system rules (enforced by tests)

- `src/styles/globals.css` is the source of truth: its `@theme` block holds dark values and generates Tailwind utilities (`bg-surface-2`, `text-fg-muted`, `border-border-strong`); a `prefers-color-scheme: light` block overrides them. Change `globals.css` and `docs/design-system/tokens.json` together — `design-system-docs.test.ts` fails on drift.
- No raw colors in components (`bg-neutral-800`, `text-white`, `bg-[#121212]`) — `design-tokens.test.ts` fails on them. Light-mode contrast is checked by `theme-contrast.test.ts`.
- Use `src/components/ui/` primitives (`Button`, `IconButton`) before styling a `<button>` by hand; every focusable control gets the `focus-ring` utility. Shadows are `shadow-popover` / `shadow-dialog`.
- UI copy: sentence case, short declarative sentences, address the user as "you", name the agents rather than saying "AI". See `docs/design-system/README.md`.

## Project rules

- The app never asks for or stores API keys/tokens; agents sign in with their own tools. The CSP (`tauri.conf.json`) allows only the local IPC bridge — the webview makes no network requests. The backend makes only two kinds: it reads the ACP registry, and on **Install** it downloads from the hosts that install needs (listed in the README's privacy section).
- Prefer a focused hook in `src/hooks/` or a helper in `src/lib/` over growing `App.tsx`.
- Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `ci:`); branches `feat/…`, `fix/…`, `chore/…`. Add a line under `Unreleased` in `CHANGELOG.md` for user-visible changes.
- Release: bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, roll the changelog, then push a `vX.Y.Z` tag; the Release workflow builds a universal macOS app into a draft release.
- xterm 6 breaks under esbuild's syntax minifier, so `vite.config.ts` sets `esbuild.minifySyntax: false`; `xterm-release-build.test.ts` guards it. Don't remove it.
