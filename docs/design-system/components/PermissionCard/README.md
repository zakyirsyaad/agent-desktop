# PermissionCard

An agent's request for permission, inline in the chat, with the agent's own choices as buttons.

The consumer provides the agent's name, what it wants to do in one sentence, the exact command or file, and the options the agent offers.

- `attention-surface` with a full `attention-border` and `radius-xl`; the alert icon is `status-attention`. No colored left edge.
- The title in `fg` says who wants what: "Claude Code wants to run a command".
- The command sits in a `code` block on `bg`.
- The agent's allow option is the primary button, its persistent allow is outline, and its reject is danger. Keep the agent's own option labels.
