# Changelog

All notable changes to Zorvo. Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

To be released as 0.2.0.

### Changed

- **Agent Desktop is now Zorvo.** New name, icon and bundle identifier (`xyz.zorvo.desktop`). On first launch Zorvo copies your sessions and transcripts from the old `com.agentdesktop.app` data folder and leaves that folder untouched. Delete Agent Desktop from Applications afterwards: both apps share the old sessions' worktrees, so deleting a session in one removes its worktree for the other. macOS ties notification and folder permissions to the bundle identifier, so grant them to Zorvo again.

### Added

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

### Changed

- App logic moved out of `App.tsx` into focused hooks. ([#8], [#12])

### Fixed

- A rewound session restarts on the model and effort it ran with. ([#16])
- `gh` calls time out instead of piling up on a stalled network. ([#16])
- The pull request menu stays open while an agent streams. ([#16])

## [0.1.0] - 2026-10-17

### Added

- Qwen Code, Claude Code and Codex over the Agent Client Protocol, in a chat UI with their own modes, models, permission requests, diffs and slash commands. ([#2])
- Oh-My-Pi and Aider in their own terminal. ([#2])
- Collapsible thinking, a working indicator and a context meter. ([#3])
- GFM Markdown, a Content Security Policy, notifications, and a macOS release workflow. ([#4])

### Fixed

- Approval safety, terminal handling, the stream parser and working folders. ([#1])

[Unreleased]: https://github.com/zakyirsyaad/agent-desktop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zakyirsyaad/agent-desktop/releases/tag/v0.1.0
[#1]: https://github.com/zakyirsyaad/agent-desktop/pull/1
[#2]: https://github.com/zakyirsyaad/agent-desktop/pull/2
[#3]: https://github.com/zakyirsyaad/agent-desktop/pull/3
[#4]: https://github.com/zakyirsyaad/agent-desktop/pull/4
[#5]: https://github.com/zakyirsyaad/agent-desktop/pull/5
[#6]: https://github.com/zakyirsyaad/agent-desktop/pull/6
[#7]: https://github.com/zakyirsyaad/agent-desktop/pull/7
[#8]: https://github.com/zakyirsyaad/agent-desktop/pull/8
[#9]: https://github.com/zakyirsyaad/agent-desktop/pull/9
[#11]: https://github.com/zakyirsyaad/agent-desktop/pull/11
[#12]: https://github.com/zakyirsyaad/agent-desktop/pull/12
[#13]: https://github.com/zakyirsyaad/agent-desktop/pull/13
[#14]: https://github.com/zakyirsyaad/agent-desktop/pull/14
[#15]: https://github.com/zakyirsyaad/agent-desktop/pull/15
[#16]: https://github.com/zakyirsyaad/agent-desktop/pull/16
[#17]: https://github.com/zakyirsyaad/agent-desktop/pull/17
