# Changelog

All notable changes to Zorvo. Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- **Install agents from Zorvo.** Choose an agent that is not installed and click **Install**. Zorvo downloads it, and Node.js or uv when you need them, and checks every download against its SHA-256 hash. Setup no longer needs an installed agent: on a Mac without Node.js, the first new session offers **Install**.
- **Agents from the ACP registry.** Zorvo reads the official ACP agent registry and runs its agents as chats. Only the agents in use show up: Claude Code, Codex and Qwen Code by default, plus installed ones; adding other registry agents comes in a later release. Zorvo checks the registry in the background at startup when the last check is over a day old, and when you click **Check again** in Settings.
- **Installed agents show up on their own.** An agent already on your Mac, as a binary on your `PATH` or an npm package installed globally, is enabled automatically, once.
- **New versions are offered after a week.** A version is offered a week after it was published, and never one the registry has withdrawn. Zorvo keeps the version an agent started with; updating it comes in a later release.
- **Landing page.** A marketing site for Zorvo in `site/` (Next.js, exported as static HTML): the hero with a picture of the app, the supported agents, features, approvals and diffs, privacy, and the download. It follows the design system, dark by default and light when your system is, with self-hosted fonts and no requests to other sites.

### Changed

- **Claude Code, Codex and Qwen Code now come from the ACP registry.** Their saved sessions carry over. Zorvo's backend reads the registry from `cdn.agentclientprotocol.com` and, when you click **Install**, contacts the hosts an install needs (see the install entry above); the window itself still makes no network requests.
- **Qwen Code no longer needs a global `qwen` install.** It runs with `npx` like Claude Code and Codex, so it needs Node.js 22+; a global install only makes it show up as installed.
- **The repository is now [zakyirsyaad/zorvo](https://github.com/zakyirsyaad/zorvo).** Links to the old `agent-desktop` address still redirect there.

### Fixed

- **Claude Code and Codex show their options before the first message.** Picking an agent for a new session now asks it what it offers, so its permission mode, model, effort and slash commands show right away, even for an agent that never ran before.
- **Sign in before you write.** An agent that needs a sign-in now says so as soon as you pick it. When Claude Code refuses a message because you are signed out, Zorvo asks you to sign in and puts the message back in the composer, instead of reporting a failed turn.
- **The composer no longer overflows.** With many options showing, the controls wrap onto a second line and the send button stays inside the composer.

## [0.2.0] - 2026-10-19

### Changed

- **Agent Desktop is now Zorvo.** New name, icon and bundle identifier (`xyz.zorvo.desktop`). On first launch Zorvo copies your sessions and transcripts from the old `com.agentdesktop.app` data folder and leaves that folder untouched. Delete Agent Desktop from Applications afterwards: both apps share the old sessions' worktrees, so deleting a session in one removes its worktree for the other. macOS ties notification and folder permissions to the bundle identifier, so grant them to Zorvo again.
- **A new look.** Zorvo uses its own design system: Instrument Sans for the interface, Geist Mono for code and the terminal, and one set of colors throughout. Amber now only marks an agent that is waiting on you, hints and timestamps are easier to read, and keyboard focus shows a clear ring. ([#35])
- App logic moved out of `App.tsx` into focused hooks. ([#8], [#12])

### Added

- **Light mode.** Zorvo follows your Mac's appearance, or pin it to Light or Dark in Settings → Appearance. The terminal stays dark either way. ([#36])
- **Diff view.** A `+N −M` chip beside Changes totals the uncommitted lines. Click it to read every changed file's diff with line numbers, against `HEAD` or the branch's base on `main`, with a path filter and Expand all. ([#39], [#40])
- **Background tasks.** A top-bar menu lists what is running: agents mid-turn, terminals, and the shell commands and dev servers your agents started, with their port and how long they have run. Open one, or stop it. ([#39], [#40])
- **Sessions by workspace.** The sidebar groups sessions under their folder, with forks nested under the session they came from. A new session is set up (folder, agent, model, effort) before its first message starts it. ([#5])
- **Worktrees.** A session can run in its own git worktree on an `agent/<title>` branch, so agents working in one repository at once never edit the same files. ([#6])
- **Changes panel.** Review every uncommitted file with its diff, and commit the files you choose. It never pushes or throws changes away. ([#7])
- **Session management.** Rename, pin and archive sessions. ([#9])
- **@-mentions and drag and drop.** Mention a workspace file with `@` in the composer, or drop files onto the window. ([#11])
- **Unread marks.** A session whose agent finished while you were elsewhere is marked. ([#13])
- **Remembered model and effort.** New sessions start with the model and effort you picked last. ([#13])
- **Pull request status.** The top bar shows the pull request for the session's branch and how its checks stand, read with your own `gh`. ([#14])
- **Your pull requests in the Changes panel.** It lists the pull requests you opened in the repository. ([#15])
- **Context details.** Click the context meter to see the tokens used, the tokens left and the session's cost. ([#15])
- **Agent logos.** The session list and Detected Agents show each agent's logo. ([#15])
- **Rewind.** Under each of your messages: its time, Copy, and Rewind, which takes the conversation back to before that message and puts it back in the composer. ([#15])
- **Workspace header.** The session's folder and branch sit above its conversation. ([#15])
- **Check again in Settings.** Detect an agent installed while the app runs, without running setup again. ([#17])

### Fixed

- A rewound session restarts on the model and effort it ran with. ([#16])
- `gh` calls time out instead of piling up on a stalled network. ([#16])
- The pull request menu stays open while an agent streams. ([#16])
- Terminal agents keep drawing in the released app. Oh-My-Pi's screen froze on its first frame because the release build broke how the terminal answers its startup queries. ([#41])
- Your message to a terminal agent is submitted, not left sitting in its prompt. ([#41])
- A new terminal session no longer shows "Failed to resize the terminal". ([#41])

## [0.1.0] - 2026-10-17

### Added

- Qwen Code, Claude Code and Codex over the Agent Client Protocol, in a chat UI with their own modes, models, permission requests, diffs and slash commands. ([#2])
- Oh-My-Pi and Aider in their own terminal. ([#2])
- Collapsible thinking, a working indicator and a context meter. ([#3])
- GFM Markdown, a Content Security Policy, notifications, and a macOS release workflow. ([#4])

### Fixed

- Approval safety, terminal handling, the stream parser and working folders. ([#1])

[Unreleased]: https://github.com/zakyirsyaad/zorvo/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zakyirsyaad/zorvo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zakyirsyaad/zorvo/releases/tag/v0.1.0
[#1]: https://github.com/zakyirsyaad/zorvo/pull/1
[#2]: https://github.com/zakyirsyaad/zorvo/pull/2
[#3]: https://github.com/zakyirsyaad/zorvo/pull/3
[#4]: https://github.com/zakyirsyaad/zorvo/pull/4
[#5]: https://github.com/zakyirsyaad/zorvo/pull/5
[#6]: https://github.com/zakyirsyaad/zorvo/pull/6
[#7]: https://github.com/zakyirsyaad/zorvo/pull/7
[#8]: https://github.com/zakyirsyaad/zorvo/pull/8
[#9]: https://github.com/zakyirsyaad/zorvo/pull/9
[#11]: https://github.com/zakyirsyaad/zorvo/pull/11
[#12]: https://github.com/zakyirsyaad/zorvo/pull/12
[#13]: https://github.com/zakyirsyaad/zorvo/pull/13
[#14]: https://github.com/zakyirsyaad/zorvo/pull/14
[#15]: https://github.com/zakyirsyaad/zorvo/pull/15
[#16]: https://github.com/zakyirsyaad/zorvo/pull/16
[#17]: https://github.com/zakyirsyaad/zorvo/pull/17
[#35]: https://github.com/zakyirsyaad/zorvo/pull/35
[#36]: https://github.com/zakyirsyaad/zorvo/pull/36
[#39]: https://github.com/zakyirsyaad/zorvo/pull/39
[#40]: https://github.com/zakyirsyaad/zorvo/pull/40
[#41]: https://github.com/zakyirsyaad/zorvo/pull/41
