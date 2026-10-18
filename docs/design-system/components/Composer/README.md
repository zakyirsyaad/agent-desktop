# Composer

The message box at the bottom of a session: a growing textarea above a bar of agent, model and context controls, ending in Send.

The consumer provides the placeholder (name the active agent), the controls in the bar and the send handler.

- `surface-2` with a `border` edge, `radius-xl` and `shadow-popover`; the edge turns `border-strong` while focused.
- Text in `body` on `fg`; placeholder in `fg-subtle`.
- Agent, model and mode pickers are `Select` triggers; attachments sit above the textarea as `Chip`s.
- Send is the only primary control and is disabled while the text is empty.
