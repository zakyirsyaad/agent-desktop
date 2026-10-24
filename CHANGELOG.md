# Changelog

All notable changes to Zorvo. Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed

- **The terminal drawer scrolls, and its latest line stays in view.** The shell took its height from its own output, so every fit added a row: it grew past the bottom of the window, the prompt and newest output fell out of sight, and nothing was left in its scrollback to scroll. It now fills the drawer, and the sign-in terminal no longer clips its last row.

## [0.4.0] - 2026-10-24

### Added

- **A terminal for the session's folder.** The **Terminal** button in the top bar opens a drawer under the chat and the side panels with a shell in the folder the session works in (its worktree, when it has one). Each folder keeps its own tabs, so switching sessions and coming back leaves them as they were; **New terminal** adds a tab, and the drawer's edge resizes it. The shell is your login shell, and closing a tab or quitting Zorvo ends the shell and the processes running under it (a job detached from the shell, or left after `exit`, can outlive it). A worktree's terminals end when Zorvo removes that worktree; a worktree it keeps (with uncommitted changes, or still used by another session) keeps them.
- **Image attachments show themselves.** A picture attached from Finder, the file picker or a workspace file is a thumbnail in the composer and above the sent message, and opens larger on a click. Another file keeps its chip, and a picture that cannot be read says "Image not found" instead of showing a broken image. The backend checks the file's type by its first bytes and refuses anything over 10 MB, then lets the window load just that file, so large pictures are never copied into the window's memory.
- **The agent's plan stays in reach.** The session's current plan sits in the top bar, beside Background tasks, with a count of the steps it has done. The conversation keeps one quiet "Updated the plan" line where the steps used to scroll away.
- **Tool calls sit where they happened in a reply.** Each run of tools folds into one line, such as "Ran 2 commands, read 3 files", that opens on a click; a part that changes a file opens on its own so you see the diff. Older saved conversations render as they did.
- **Background tasks lists the work itself, not only the session.** A running shell command or subagent gets its own row with its session and how long it has run, and Open jumps to it. A shell row that matches a running process is shown once, as the process, so Stop still works.

### Fixed

- **A session started right after a reload is no longer stopped.** When it loads, Zorvo ends the agents and shells a previous window left running. It now lists them the moment the window asks and ends exactly those, so a session, terminal or sign-in you start meanwhile keeps running and starts at once.
- **The landing site uses Next.js 16.4.2.** 16.3.8 is affected by advisories GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr and GHSA-p3m5-59mp-jv5r.
- **A permission request shows one card, and says when the mode changed after it.** A replayed or duplicated request no longer adds a second card. If you switch modes while a request waits, the card says the agent asked before the switch, so its answer is still expected.
- **A composer menu leaves a long conversation alone.** Folder, agent, permission, model and effort menus keep their open state inside the composer, so opening or closing one does not re-render the message list; a regression test now holds that.
- **A background pull request refresh stays quiet.** If `gh` is slow after the Mac wakes, the top bar keeps the last pull request it read instead of a red notice; the next minute or focus tries again. After three failed reads in a row, such as when you are signed out of `gh`, it stops showing checks it can no longer confirm.
- **A long session scrolls smoothly.** Finished tool rows, diffs and outputs stay out of the page until you open them; earlier turns start collapsed, and a huge diff or output shows its first 400 rows with the rest one click away. Saved conversations without reply parts now get the same compact rows.
- **Saving a conversation no longer fails while its agent runs.** Two saves of one session at once shared a scratch file, so one could move it away from the other and report "Failed to replace … No such file or directory". Each save now has its own scratch file and waits for the one before it.
- **A dev build keeps its own data.** `pnpm tauri dev` now stores sessions in `xyz.zorvo.desktop.dev` beside the installed app's folder, so testing never writes your daily sessions and the two never save over each other.
- **A shell command that replaces its shell shows up in Background tasks.** Qwen Code starts each command in its own process group and a simple command replaces the shell, so the scan saw no shell and listed nothing; it now lists the group leader too.

- **Scrolling up while the agent streams leaves the bottom at once.** A small upward scroll, wheel or key keeps your place, so a streaming reply no longer shakes the view or snaps it back down while you read.
- **A reply shows Copy, Fork and Read aloud once its turn ends.** The reply the agent is still writing no longer offers actions or a timestamp, so you cannot copy or fork half an answer.
- **A session's status dot stays at the right edge.** The dot no longer shifts with the actions beside it, so every row lines up, and the actions replace it when you hover or focus the row.
- **A long session stays responsive while the agent streams.** Streamed output lands once a frame, and only the reply that changed re-renders, so typing and scrolling keep up in a session with a long history.

## [0.3.0] - 2026-10-22

### Added

- **Install agents from Zorvo.** Choose an agent that is not installed and click **Install**. Zorvo downloads it, and Node.js or uv when you need them, and checks every download against its SHA-256 hash. You can write your first message while it installs. Setup no longer needs an installed agent: on a Mac without Node.js, the first new session offers **Install**.
- **An agent catalog in Settings.** The Agents tab lists every ACP registry agent with search and logos, and adds, installs, updates and removes them. Onboarding uses the same list.
- **Agents from the ACP registry.** Zorvo reads the official ACP agent registry and runs its agents as chats. Only the agents in use show up: Claude Code, Codex and Qwen Code by default, plus installed ones. Add any other registry agent from Settings → Agents. Zorvo checks the registry in the background at startup when the last check is over a day old, and when you click **Check again** in Settings.
- **Installed agents show up on their own.** An agent already on your Mac, as a binary on your `PATH` or an npm package installed globally, is enabled automatically, once.
- **New versions are offered after a week.** A version is offered a week after it was published, and never one the registry has withdrawn. Zorvo keeps the version an agent started with, unless the registry withdraws it. **Update** in Settings → Agents moves an agent to its offered version.
- **Agent update notice.** When an agent you use has a new version, the Settings button in the sidebar shows a dot, the Agents tab shows a count, and a notice tells you once per version. **Show** opens the Agents tab.
- **Landing page.** A marketing site for Zorvo in `site/` (Next.js, exported as static HTML): the hero with a picture of the app, the supported agents, features, approvals and diffs, privacy, and the download. It follows the design system, dark by default and light when your system is, with self-hosted fonts and no requests to other sites.
- **Sign in from Zorvo.** Agents that sign in through their own login, such as Claude Agent's Claude subscription or Anthropic Console, now offer it in the sign-in panel. The login runs in a terminal inside Zorvo, and your message is sent once you are signed in. Zorvo never sees or stores your keys.
- **Agents can ask you for input.** An agent can show a form in the chat, or send you to a web page to sign in (ACP elicitation). You answer in the chat or in a popout window, and what you type is never saved.
- **Pick a branch for a new session.** The folder list has a **Branch** row with the repository's local branches and a search. With **Worktree** off, picking one switches your folder to it, as `git switch` would, and Zorvo leaves it alone while a session's agent works anywhere in that checkout. With **Worktree** on, the new worktree starts from the branch you pick and your folder stays as it is.
- **Continue a session where its agent left it.** Zorvo continues a session with the agent's own resume when it offers one, and you can continue a session started outside Zorvo (for example in the agent's CLI) from the new-session screen.

### Changed

- **Claude Code, Codex and Qwen Code now come from the ACP registry.** Their saved sessions carry over. Zorvo's backend reads the registry from `cdn.agentclientprotocol.com` and, when you click **Install**, contacts the hosts an install needs (see the install entry above); the window itself still makes no network requests.
- **Qwen Code no longer needs a global `qwen` install.** It runs with `npx` like Claude Code and Codex, so it needs Node.js 22+; a global install only makes it show up as installed.
- **The repository is now [zakyirsyaad/zorvo](https://github.com/zakyirsyaad/zorvo).** Links to the old `agent-desktop` address still redirect there.

### Removed

- **Oh-My-Pi, Aider and terminal sessions.** Every agent now runs as an ACP chat. Saved terminal sessions are deleted the first time Zorvo opens; the worktree of a deleted terminal session stays on disk under Zorvo's app data `worktrees/` folder.

### Fixed

- **The prompt no longer turns `--flag` into an en dash or straight quotes into curly ones.** Zorvo now registers the WebView's smart dashes, quotes, text replacement and spelling correction as off for the app, and the composer turns off autocorrection and spellcheck.
- **The Settings dialog no longer moves while you use it.** It sits near the top at a fixed height, with the list scrolling inside, so typing in the search or removing an agent no longer slides the close button away.
- **A fork's first message no longer shows a handoff file path.** When an agent has no native fork, the new session's chat says "Pick up from the previous session." The path goes to the agent as hidden context, along with an instruction to reply that it is ready and wait for your next message instead of resuming the old task.
- **An imported session no longer says "Just now" on every message.** A replay from the agent carries no per-message time, so Zorvo shows no time there instead of one it made up.
- **A worktree's starting branch stays with its session.** Once a session starts from the branch you picked, the next draft starts from the folder's own branch again. The new-session card also names the branch the worktree will start from.
- **A sign-in request stays with its agent.** When Claude Code needs a sign-in, the panel no longer shows above a Qwen Code session or draft. It comes back when you return to a Claude Code session.
- **An agent being installed says so.** While an install or update runs, its row says **Installing …** instead of **Not installed**, and a failure shows its reason in the status line.
- **Slash command search finds a name by any segment.** Typing `/brainst` now finds `superpowers:brainstorming`, and a prefix match still comes first.
- **Claude Code and Codex show their options before the first message.** Picking an agent for a new session now asks it what it offers, so its permission mode, model, effort and slash commands show right away, even for an agent that never ran before.
- **Sign in before you write.** An agent that needs a sign-in now says so as soon as you pick it. When Claude Code refuses a message because you are signed out, Zorvo asks you to sign in and puts the message back in the composer, instead of reporting a failed turn.
- **The composer no longer overflows.** With many options showing, the controls wrap onto a second line and the send button stays inside the composer. Turning on **Worktree** swaps the folder icon for a branch icon instead of adding one, so the controls no longer jump to a second line when you flip it.
- **Agents no longer stall while a session opens.** Zorvo now answers every request an agent sends, even before its session is ready, so an agent that asks something during startup is no longer left waiting up to a minute. A permission request an agent sends right after a session opens now reaches you, and one for a session Zorvo does not know is cancelled. Two sessions of the same agent no longer mix up each other's messages when the agent gives both the same id. Forking is refused for an agent that cannot fork.
- **A tool still running when its turn ends settles.** It now shows as failed instead of running forever, since a turn cannot end while a tool is genuinely working.

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

[Unreleased]: https://github.com/zakyirsyaad/zorvo/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/zakyirsyaad/zorvo/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/zakyirsyaad/zorvo/compare/v0.2.0...v0.3.0
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
