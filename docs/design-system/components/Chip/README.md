# Chip

A small labelled pill for an attached file or a code reference.

The consumer provides the label and, for attachments, a remove handler with an `aria-label` that names the file.

- Attachments: `caption` text in `fg-secondary` on `surface-2`, `border` edge, `radius-md`.
- Code references (`z-chip--code`): `code-sm` in `fg-muted`, `radius-sm`, for paths, branches and PR numbers.
- Keep labels to the file name; show the full path in a tooltip.
