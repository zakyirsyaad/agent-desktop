# Reply Flow and Background Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each reply's text and tool calls in the order they happened, and make the Background tasks menu list every running piece of work.

**Architecture:** Add an ordered `parts` list beside the existing `content` and `tools` on an agent message; the reducer appends text and tool parts as updates arrive, and `MessageRow` renders them in order behind compact, expandable summary rows. For background tasks, list running tool calls from the transcripts the frontend already holds, de-duplicate them against the OS processes the backend reports, and fix whatever the backend scan misses.

**Tech Stack:** React 19, TypeScript, Tailwind 4, Vitest + Testing Library, Tauri 2, Rust.

**Spec:** This plan implements work order B, `qwen-work-order-B-reply-flow-background-tasks.md`, with the approved design recorded in the conversation (summary-row wording, collapsed by default except a part with a diff).

## Global Constraints

- UI copy is sentence case, short declarative sentences, addresses the user as "you", names the agents, never says "AI".
- No raw colors; use tokens. Use `src/components/ui/` primitives. Every focusable control gets `focus-ring`. Shadows are `shadow-popover` / `shadow-dialog`.
- `ChatCanvas.tsx` and `App.tsx` must not grow much: put logic in `src/lib/` or a focused hook.
- Saved transcripts from older versions must keep loading; malformed `parts` are dropped, never fail the load.
- Add `CHANGELOG.md` lines under `## [Unreleased]` (`### Added` / `### Fixed`).
- Never log, store or ask for API keys or tokens.
- Stage explicit paths only in commits; never `git add -A`.

## Review Focus

- A text chunk that arrives after a tool call must start a new text part, and `content` must keep the blank line between parts.
- A tools part with a diff must be readable without a click, while a command-only part stays compact.
- An old transcript without `parts` must render exactly as today.
- A running shell tool call and the OS process it started must appear once, preferring the process row.
- A tool call from a finished turn must not appear in Background tasks.

---

## Part 1

### Task 1: Ordered reply parts in the ACP reducer

**Files:**
- Modify: `src/types/index.ts` (add `ChatMessagePart`, `parts` on `ChatMessage`)
- Modify: `src/lib/acp-events.ts`
- Test: `src/test/acp-events.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ChatMessagePart = { kind: 'text'; text: string } | { kind: 'tools'; toolIds: string[] }`; `ChatMessage.parts?: ChatMessagePart[]`.

- [ ] **Step 1: Write the failing tests**

In `src/test/acp-events.test.ts`, add a `describe("reply parts")` with:
- text → tool → text → tool yields four parts in order: `['text', 'tools', 'text', 'tools']`, tool ids in the tools parts;
- two text chunks in a row stay one text part;
- two text parts give `content === "files\n\nLet me"`;
- replay (`applyReplayUpdate`) produces the same order and blank-line join.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/test/acp-events.test.ts`
Expected: FAIL because `parts` is undefined.

- [ ] **Step 3: Implement the parts fold**

In `acp-events.ts`:
- `agent_message_chunk`: append to the last part when it is `text`; otherwise push a new text part. Recompute `content` from the text parts joined by `'\n\n'`.
- `addToolCall`: push the new id onto the last part when it is `tools`; otherwise push a new tools part.
- Leave `tool_call_update`, thinking, plan and the permission card untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/test/acp-events.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/lib/acp-events.ts src/test/acp-events.test.ts
git commit -m "feat: keep reply parts in the order they happened"
```

### Task 2: Validate saved parts on load

**Files:**
- Modify: `src/lib/persistence.ts`
- Test: `src/test/persistence.test.ts`

**Interfaces:**
- Consumes: `ChatMessagePart` from Task 1.
- Produces: `normalizeTranscript(raw: unknown): ChatMessage[]` in `persistence.ts`; `loadTranscript` uses it.

- [ ] **Step 1: Write the failing tests**

In `src/test/persistence.test.ts`:
- an old message without `parts` loads, and `parts` stays undefined;
- a message with a valid `parts` list keeps it;
- a message whose `parts` is not an array, or holds an unknown part kind, or a text part without a string, or a tools part with non-string ids, loads with `parts` dropped and every other field intact;
- an empty `parts` array is dropped.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/test/persistence.test.ts`
Expected: FAIL because `normalizeTranscript` does not exist.

- [ ] **Step 3: Implement `normalizeTranscript`**

Validate every message as an object with `id`, `role`, `content`, `timestamp`; keep the rest as is. For `parts`, keep it only when every entry is well formed; drop it otherwise. Do not bump `STATE_VERSION` — it versions `state.json`, not transcripts.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/test/persistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/persistence.ts src/test/persistence.test.ts
git commit -m "fix: drop a malformed reply parts list on load"
```

### Task 3: Render reply parts with expandable summary rows

**Files:**
- Create: `src/lib/tool-summary.ts`
- Create: `src/components/chat/ToolsPart.tsx`
- Modify: `src/components/chat/MessageRow.tsx`
- Test: `src/test/tool-summary.test.ts`
- Test: `src/test/chat-canvas.test.tsx`

**Interfaces:**
- Consumes: `ToolExecution`, `ChatMessagePart`.
- Produces:
  - `summarizeTools(tools: readonly ToolExecution[]): string` — e.g. `"Ran 2 commands, read 3 files"`.
  - `ToolsPart({ tools, defaultOpen? })` — renders one summary `<button>` with `aria-expanded` and the existing `ToolCallList` when open.

- [ ] **Step 1: Write the failing label tests**

In `src/test/tool-summary.test.ts`, pin:
- 1 execute → `"Ran a command"`; 2 execute → `"Ran 2 commands"`;
- 1 read → `"Read a file"`; 3 read → `"Read 3 files"`;
- 1 edit → `"Edited a file"`; 2 edit → `"Edited 2 files"`;
- search → `"Searched the code"`; 1 fetch → `"Fetched a page"`;
- `think`/`other`/no kind → `"Used a tool"` / `"Used 2 tools"`;
- mixed first-appearance order → `"Read 2 files, ran a command"`;
- a failed tool appends `"· 1 failed"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/test/tool-summary.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement `summarizeTools`** in `src/lib/tool-summary.ts`

Count by kind, keep first-appearance order, join with `", "`, capitalize the first phrase only. Keep a running phrase out of the static label; the component shows the running tool's own title in its place.

- [ ] **Step 4: Run the label tests to verify they pass**

Run: `pnpm vitest run src/test/tool-summary.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing rendering tests**

In `src/test/chat-canvas.test.tsx`:
- a message with `parts` renders text before tools and text after tools in part order;
- a tools part shows its summary label and starts collapsed;
- clicking the summary button sets `aria-expanded="true"` and shows the tool names;
- a tools part with a diff starts open;
- a tools part with a running tool shows that tool's title and a running state;
- a message without `parts` renders tools before text, as before.

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm vitest run src/test/chat-canvas.test.tsx`
Expected: FAIL because the parts are ignored.

- [ ] **Step 7: Implement `ToolsPart` and wire it into `MessageRow`**

`ToolsPart` holds `useState(hasDiff)` for its expanded state, renders `<button type="button" aria-expanded>` with a `focus-ring` and a chevron, the label from `summarizeTools`, the first running tool's title with a muted pulsing `Running`, and `<ToolCallList tools={tools} />` when expanded. `MessageRow` renders `message.parts` when present (text → `MarkdownRenderer`, tools → `ToolsPart`), else the existing tools-then-content layout. `ToolsPart` is keyed by part index, so each part has its own state.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run src/test/chat-canvas.test.tsx src/test/tool-summary.test.ts`
Expected: PASS.

- [ ] **Step 9: Add the changelog line and commit**

```markdown
### Added
- Replies show text and tool calls in the order they happened, with compact rows you can expand.
```

```bash
git add src/lib/tool-summary.ts src/components/chat/ToolsPart.tsx src/components/chat/MessageRow.tsx src/test/tool-summary.test.ts src/test/chat-canvas.test.tsx CHANGELOG.md
git commit -m "feat: show a reply's text and tools in order"
```

## Part 2

### Task 4: Diagnose the missing shell process

**Files:**
- Read: `src-tauri/src/background_processes.rs`, `src-tauri/tests/background_processes_test.rs`
- Modify: whichever the diagnosis proves wrong, plus its test.

**Interfaces:**
- Consumes: `scan(roots, with_ports)`.
- Produces: the same public functions with the fixed selection.

- [ ] **Step 1: Reproduce with a real agent** — run `pnpm tauri dev`, ask Qwen Code to run a slow shell command, open Background tasks, and record what the menu shows.

- [ ] **Step 2: Check each hypothesis against the code** — another process group, a grandchild shell, a short life between polls, an agent pid that is not the parent, or the transcript not being polled at all.

- [ ] **Step 3: Write the failing Rust test** for the confirmed cause in `src-tauri/tests/background_processes_test.rs`.

- [ ] **Step 4: Run it to verify it fails** — `cargo test --test background_processes_test`.

- [ ] **Step 5: Fix the scan and run the test to green**, then `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/background_processes.rs src-tauri/tests/background_processes_test.rs
git commit -m "fix: list the shell commands agents start"
```

### Task 5: Add running tool calls as background tasks

**Files:**
- Modify: `src/lib/background-tasks.ts`
- Test: `src/test/background-tasks.test.ts`

**Interfaces:**
- Consumes: `ChatMessage[]` by session id.
- Produces:
  - `BackgroundTaskKind = 'agent' | 'shell' | 'subagent' | 'process'`;
  - `runningToolTasks(transcripts: Readonly<Record<string, readonly ChatMessage[]>>, sessions: readonly Session[]): BackgroundTask[]`;
  - `backgroundTasksOf` takes `transcripts` and merges tool tasks before de-duplicating.

- [ ] **Step 1: Write the failing tests**

- an `execute` tool with status `running` becomes kind `shell`, named by its title;
- a Claude Code subagent (`kind: 'think'`, title that is not plain thinking) becomes kind `subagent`; a Qwen Code `task` tool becomes kind `subagent`;
- a completed tool is not listed;
- a shell tool whose command matches a process in the same session yields one row, the process row;
- a process whose tool call already completed still shows;
- the list stays oldest first.

- [ ] **Step 2: Run them to verify they fail** — `pnpm vitest run src/test/background-tasks.test.ts`.

- [ ] **Step 3: Implement `runningToolTasks` and the merge.**

Subagent detection is by the ACP tool title/name (`task`), never by `kind: 'think'` alone, because Claude's and Codex's adapters use `think` for plain reasoning too.

- [ ] **Step 4: Run the tests to verify they pass** — same command.

- [ ] **Step 5: Wire the transcripts through `useBackgroundTasks` and `App.tsx`** (one prop, no new state).

- [ ] **Step 6: Commit**

```bash
git add src/lib/background-tasks.ts src/hooks/useBackgroundTasks.ts src/App.tsx src/test/background-tasks.test.ts
git commit -m "feat: list running tool calls as background tasks"
```

### Task 6: Group the menu by kind

**Files:**
- Modify: `src/components/topbar/BackgroundTasksMenu.tsx`
- Test: `src/test/background-tasks-menu.test.tsx`

**Interfaces:**
- Consumes: `BackgroundTask` from Task 5.
- Produces: the same props; rows gain a kind icon (`Bot`, `Terminal`, `Users`, `Cog`), the session name, elapsed time, Open, and Stop only where it can act.

- [ ] **Step 1: Write the failing menu tests** — one row of each kind renders with its icon and session name; Stop is absent on `shell`/`subagent` without a process; the count matches the rows.

- [ ] **Step 2: Run them to verify they fail** — `pnpm vitest run src/test/background-tasks-menu.test.tsx`.

- [ ] **Step 3: Implement the rows** — labels come from the kind; Open jumps to the session (a tool row may pass its tool id through the callback).

- [ ] **Step 4: Run the tests to verify they pass.**

- [ ] **Step 5: Add the changelog line and commit**

```markdown
### Fixed
- Background tasks now lists shell commands and subagents that are running, not only the session.
```

```bash
git add src/components/topbar/BackgroundTasksMenu.tsx src/test/background-tasks-menu.test.tsx CHANGELOG.md
git commit -m "feat: group background tasks by kind"
```

## Final verification

- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`, then from `src-tauri/`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`
- [ ] Run the app with a real agent (`pnpm tauri dev`, or the `tauri-dev-1422` setup), exercise both features, take screenshots.
- [ ] Code review the whole branch, fix findings, push, open the PR to `main` (do not merge).