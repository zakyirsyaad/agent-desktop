# Components

How each component looks and what its caller provides. `Button` and `IconButton` are shared primitives in `src/components/ui/`; the rest are patterns the app's own components follow. Token names are in [`tokens.json`](tokens.json).

## Button

A text button for actions in cards, dialogs and toolbars, in four variants: primary, outline, ghost and danger. In code: `<Button variant="…">` from `src/components/ui/Button.tsx`.

The caller provides the label (a verb, one to three words, sentence case) and an optional leading Lucide icon at `size-icon`.

- **Primary** (`primary` / `on-primary`): the one action a view exists for, such as Allow or Send. Never two in a view.
- **Outline** (`border-strong`): the alternatives next to it, such as Always allow or Open in Finder.
- **Ghost**: low-stakes actions such as Cancel or Show more.
- **Danger** (`danger` on `danger-surface`): destructive actions such as Deny or Delete session.
- A disabled primary turns flat (`surface-hover`, `fg-muted` label); the other variants drop to 40% opacity. All keep their label. Say why nearby rather than leaving a dead button.

Sizes: `ui` text at weight 500, `space-1.5` × `space-3` padding, `radius-lg`.

## IconButton

A square icon-only button for toolbars, the composer and row actions. In code: `<IconButton label="…">` from `src/components/ui/IconButton.tsx`.

The caller provides one Lucide icon and a `label` that says what it does ("Close", "Open terminal"); it becomes both the `aria-label` and the tooltip.

- Ghost by default: `fg-muted`, filling `surface-hover` on hover.
- `variant="primary"` is the composer's Send button only: `primary` fill at `radius-lg`.
- Always `size-control` (28px) square, so rows of them line up.

## Chip

A small labelled pill for an attached file or a code reference.

The caller provides the label and, for attachments, a remove handler with an `aria-label` that names the file.

- Attachments: `caption` text in `fg-secondary` on `surface-2`, `border` edge, `radius-md`.
- Code references: `code-sm` in `fg-muted`, `radius-sm`, for paths, branches and PR numbers.
- Keep labels to the file name; show the full path in a tooltip.

## Composer

The message box at the bottom of a session: a growing textarea above a bar of agent, model and context controls, ending in Send.

The caller provides the placeholder (name the active agent), the controls in the bar and the send handler.

- `surface-2` with a `border` edge, `radius-xl` and `shadow-popover`; the edge turns `border-strong` while focused.
- Text in `body` on `fg`; placeholder in `fg-subtle`.
- Agent, model and mode pickers are `Select` triggers; attachments sit above the textarea as `Chip`s.
- Send is the only primary control and is disabled while the text is empty.

## Dialog

A modal for settings and confirmations, over the `overlay` scrim.

The caller provides the title, the fields and the actions.

- `surface-1` with a `border` edge, `radius-xl`, `space-5` padding and `shadow-dialog`.
- Title in `heading`; a Close `IconButton` top right; Escape closes it.
- Fields: a label in `ui` weight 500, an input with a `border-strong` edge, a hint in `caption` and `fg-subtle`.
- Actions sit bottom right above a `border` rule: Cancel as ghost, the confirming action as primary.

## PermissionCard

An agent's request for permission, inline in the chat, with the agent's own choices as buttons.

The caller provides the agent's name, what it wants to do in one sentence, the exact command or file, and the options the agent offers.

- `attention-surface` with a full `attention-border` and `radius-xl`; the alert icon is `status-attention`. No colored left edge.
- The title in `fg` says who wants what: "Claude Code wants to run a command".
- The command sits in a `code` block on `bg`.
- The agent's allow option is the primary button, its persistent allow is outline, and its reject is danger. Keep the agent's own option labels.

## Select

A compact dropdown for picking an agent's mode, model or effort, and the menu it opens.

The caller provides the options (label plus an optional one-line hint) and the selected value.

- The trigger is `ui` text in `fg-secondary` with a `border` edge and `radius-lg`, ending in a chevron.
- The menu is `surface-3` with `border`, `radius-lg` and `shadow-popover`; items are `radius-sm` rows that fill `surface-hover` when hovered or selected.
- Hints sit right-aligned in `caption` and `fg-subtle`.
- Use the same menu for row context menus (Rename, Pin, Archive, Delete), with Delete last in `danger`.

## SessionRow

One session in the sidebar: its title, its status and when it last changed.

The caller provides the title (from the first message, truncated with an ellipsis), the status and a relative time.

- Rows sit on `surface-1`, `ui` text in `fg-muted`, `radius-md`.
- The open session and hovered rows fill `surface-hover` and turn `fg`. Mark the open one with `aria-current`.
- A `StatusDot` replaces the time while the agent is working, waiting or unread.
- Row actions (Rename, Pin, Archive) appear on hover as `IconButton`s or in a `Select` menu.

## StatusDot

A `size-dot` (6px) dot that says what an agent is doing, beside a session or in the top bar.

The caller provides the state and an accessible label (visible text or a tooltip), never the dot alone.

- `status-running` pulses while the agent works; the pulse stops under `prefers-reduced-motion`.
- `status-attention` means the agent is waiting on you: a permission request or a question.
- `status-unread` marks a session that finished while another was open.
- Idle sessions show no dot at all.
