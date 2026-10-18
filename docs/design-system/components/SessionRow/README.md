# SessionRow

One session in the sidebar: its title, its status and when it last changed.

The consumer provides the title (from the first message, truncated with an ellipsis), the status and a relative time.

- Rows sit on `surface-1`, `ui` text in `fg-muted`, `radius-md`.
- The open session and hovered rows fill `surface-hover` and turn `fg`. Mark the open one with `aria-current`.
- A `StatusDot` replaces the time while the agent is working, waiting or unread.
- Row actions (Rename, Pin, Archive) appear on hover as `IconButton`s or in a `Select` menu.
