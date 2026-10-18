# Dialog

A modal for settings and confirmations, over the `overlay` scrim.

The consumer provides the title, the fields and the actions.

- `surface-1` with a `border` edge, `radius-xl`, `space-5` padding and `shadow-dialog`.
- Title in `heading`; a Close `IconButton` top right; Escape closes it.
- Fields: a `label` in `ui` weight 500, an input with a `border-strong` edge, a hint in `caption` and `fg-subtle`.
- Actions sit bottom right above a `border` rule: Cancel as ghost, the confirming action as primary.
