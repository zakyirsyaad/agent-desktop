# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Zorvo (formerly Agent Desktop) is a macOS Tauri 2 app that hosts other coding agents. Qwen Code, Claude Code and Codex are driven over the Agent Client Protocol (ACP, JSON-RPC over stdio) and shown as a chat UI. Oh-My-Pi and Aider run as their real TUI in a PTY. React 19 + Tailwind 4 frontend in `src/`, Rust backend in `src-tauri/` (crate `zorvo`, lib `zorvo_lib`). Package manager is pnpm.

## Commands

```bash
pnpm install
pnpm tauri dev              # run the app (Vite on :1420 + Rust backend)
pnpm lint                   # tsc --noEmit + eslint --max-warnings=0
pnpm test                   # all Vitest tests
pnpm vitest run src/test/stream-parser.test.ts          # one file
pnpm vitest run src/test/stream-parser.test.ts -t "name" # one test
pnpm design-system          # local design-system reference on :5180
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

**Frontend ↔ backend.** The UI calls Tauri commands (all registered in `src-tauri/src/lib.rs`'s `generate_handler!`) and listens to events: `acp-event` (one channel for every ACP session, payload `{sessionId, kind: update|permission|turn-end|exit, ...}` built in `acp/commands.rs`) and `pty-output-<id>` / `pty-exit-<id>` for terminal sessions.

**Two session engines.** `App.tsx` picks one per session by the profile's transport (`TRANSPORT_ACP` vs `TRANSPORT_PTY`):
- `src/hooks/session-engine/useAcpEngine.ts` — chat sessions. ACP updates are folded into chat messages by `src/lib/acp-events.ts`; modes/models/config options come from the agent at session start (`useAcpSessions.ts`, `lib/acp-draft.ts`).
- `src/hooks/session-engine/usePtyEngine.ts` — terminal sessions via xterm; `lib/stream-parser.ts` detects `[y/n]` prompts in PTY output.

**Agent profiles are the trust boundary.** `src-tauri/src/profiles.rs` statically declares each agent CLI: its command, the flags the app may pass (efforts, permission modes, fork support), and its transport. The webview only ever sends a `profile_id` plus `SpawnOptions`; `spawn_plan.rs` validates them into a command line and `acp/commands.rs::launch_for` does the same for ACP. Never let the UI pass a raw command or args. The Claude/Codex ACP adapters are pinned `npx` packages in `profiles.rs` (pinned to releases at least two weeks old, on purpose).

**ACP backend** (`src-tauri/src/acp/`): `jsonrpc.rs` framing, `connection.rs` one agent process, `manager.rs` maps app session ids onto ACP sessions. One agent process can host several ACP sessions (a native fork lives in its source's process), so connections are shared and killed only when their last session stops. Auth-required errors are surfaced to the UI as `ACP_AUTH_REQUIRED:` + JSON (parsed in `src/lib/acp-auth.ts`), both when a session opens and when a prompt is refused (Claude Code's adapter opens sessions signed out and refuses only the prompt).

**Probing a draft's agent.** ACP agents report modes/models/efforts/slash commands only inside a session, so `acp/probe.rs` (`acp_probe_agent`) asks in a short-lived process. For an agent that never reported its options it opens a throwaway session and deletes it (`session/delete`, else `session/close`), since opening one can run the user's session hooks and lands in the agent's history; for a known agent it only reads the `_auth/status_update` sign-in status. `src/hooks/useAgentProbe.ts` runs it once per agent per run for a new-session draft, and again on window focus while a sign-in is pending; results are merged with `withProbed` (`lib/acp-draft.ts`), which never overwrites what a real session reported.

**Environment.** A Finder-launched app has no shell PATH, so `env_resolver.rs` reads the user's login-shell environment once (warmed at startup) and every spawn uses it. `get_agent_profiles(refresh: true)` re-reads it.

**Persistence.** `store.rs` writes `state.json` and `transcripts/<id>.json` atomically under `~/Library/Application Support/xyz.zorvo.desktop/`. Frontend validation/normalization of loaded state is in `src/lib/persistence.ts` (`STATE_VERSION`); `data_migration.rs` copies data once from the old `com.agentdesktop.app` folder. On load the UI calls `end_orphaned_sessions`, because a webview reload leaves backend agents running that the new UI does not know.

**Path checks.** Every backend command that reads or runs in a folder from the UI must first call `files::ensure_known_workspace` (canonicalized, checked against the store's known workspaces). Follow this in any new command.

**Popout windows.** A session can open in its own window (`index.html?session=<id>&popout=1`, see `lib/window-mode.ts`). The main window is the single writer: it parses agent output and persists state; popouts only render snapshots and forward actions (`lib/popout-bridge.ts`), so two windows never write the same files.

**Fork, rewind, worktrees.** Fork uses the agent's native ACP fork when available, otherwise a handoff file (`fork_handoff.rs`, `lib/fork-handoff.ts`) the new agent is told to read. Worktree sessions get an `agent/<title>` branch under the app data dir's `worktrees/` (`worktrees.rs`). Git changes/commits are in `changes.rs` and `diff_stats.rs`; PR data comes from the user's own `gh` (`pull_requests.rs`).

**Threading rule for Tauri commands.** Commands that touch the filesystem, the login shell or a child process are `#[tauri::command(async)]` so they don't freeze the window. `send_input` is deliberately sync: async would run keystrokes on a thread pool where they could reach the PTY out of order.

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

- The app never asks for or stores API keys/tokens; agents sign in with their own tools. The CSP (`tauri.conf.json`) allows only the local IPC bridge — the app makes no network requests of its own.
- Prefer a focused hook in `src/hooks/` or a helper in `src/lib/` over growing `App.tsx`.
- Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `ci:`); branches `feat/…`, `fix/…`, `chore/…`. Add a line under `Unreleased` in `CHANGELOG.md` for user-visible changes.
- Release: bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, roll the changelog, then push a `vX.Y.Z` tag; the Release workflow builds a universal macOS app into a draft release.
- xterm 6 breaks under esbuild's syntax minifier, so `vite.config.ts` sets `esbuild.minifySyntax: false`; `xterm-release-build.test.ts` guards it. Don't remove it.
