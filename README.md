# Agent Desktop

A desktop app for the coding agents you already use: Qwen Code, Claude Code
and Codex in a real chat UI, and terminal agents (Oh-My-Pi, Aider) in their
own terminal. Like Claude Code Desktop, but for whichever agent you have.

- **Chat with the agent's own data.** Qwen Code, Claude Code and Codex are
  driven over the [Agent Client Protocol](https://agentclientprotocol.com):
  you get their real modes and models, permission requests with the agent's
  own choices, diffs of every file change, slash commands, context usage,
  and sessions that resume after a restart.
- **Terminal agents stay terminals.** Oh-My-Pi and Aider run as their real
  TUI in the main view.
- **Workspaces and sessions.** Sessions are grouped by folder, titled from
  the first message, and saved on disk. Fork any reply into a new session,
  pop a session out into its own window, browse the folder's files.

## Requirements

- macOS (Apple Silicon or Intel).
- **Node.js 22+ with `npx`** on your login shell's `PATH` (nvm, Homebrew…):
  Claude Code and Codex run through their ACP adapters with `npx`.
- **At least one agent CLI**, installed and signed in:

  | Agent | Install | Sign in |
  |---|---|---|
  | Qwen Code | `npm i -g @qwen-code/qwen-code` | run `qwen` once |
  | Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude`, then `/login` |
  | Codex | `npm i -g @openai/codex` | `codex login` (or the app's sign-in panel) |
  | Oh-My-Pi / Aider | see their docs | — |

The app reads your login shell's environment, so anything your terminal finds
it finds too. Installed an agent while the app runs? Click **Check again**.

## Install

Download the `.dmg` from the
[latest release](https://github.com/zakyirsyaad/agent-desktop/releases) and
drag Agent Desktop into Applications.

An unsigned build is blocked the first time you open it. Open it once, then
go to **System Settings → Privacy & Security** and click **Open Anyway** next
to the Agent Desktop message (macOS 15 no longer offers right-click → Open for
this). Or, in a terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Agent Desktop.app"
```

## Your data

Sessions and transcripts are stored in
`~/Library/Application Support/com.agentdesktop.app/` (`state.json` and
`transcripts/`). The app never asks for API keys: agents sign in with their
own tools.

## Development

```bash
pnpm install
pnpm tauri dev
```

| Check | Command |
|---|---|
| Types | `pnpm lint` |
| Frontend tests | `pnpm test` |
| Rust tests | `cd src-tauri && cargo test` |
| Rust lint | `cd src-tauri && cargo clippy --all-targets -- -D warnings` |
| Production build | `pnpm tauri build` |

CI runs the types, tests and Rust lint on every pull request. It does not
build the release bundle: run `pnpm tauri build` and open the app before a
release, since the production build is the only one that applies the
Content Security Policy.

**Layout.** `src/` is the React UI (`App.tsx` picks a session engine:
`hooks/session-engine/useAcpEngine.ts` for ACP agents,
`usePtyEngine.ts` for terminal agents). `src-tauri/src/` is the Rust backend:
`acp/` (the ACP client), `pty_session.rs`, `profiles.rs` (which agents exist
and how they are found), `store.rs` (state and transcripts).

## Releasing

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and
   `src-tauri/tauri.conf.json`.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The **Release** workflow builds a universal macOS app and attaches it to a
   draft GitHub release; publish the draft when it looks right.

To sign and notarize (so Gatekeeper opens it without a warning), add these
repository secrets from an Apple Developer account: `APPLE_CERTIFICATE`
(base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`.
Without them the build is unsigned.
