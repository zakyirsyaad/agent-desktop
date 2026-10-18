# StatusDot

A 6px dot that says what an agent is doing, beside a session or in the top bar.

The consumer provides the state and an accessible label (visible text or a tooltip), never the dot alone.

- `status-running` pulses while the agent works; the pulse stops under `prefers-reduced-motion`.
- `status-attention` means the agent is waiting on you: a permission request or a question.
- `status-unread` marks a session that finished while another was open.
- Idle sessions show no dot at all.
