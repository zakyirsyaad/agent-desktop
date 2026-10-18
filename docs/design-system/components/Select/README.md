# Select

A compact dropdown for picking an agent's mode, model or effort, and the menu it opens.

The consumer provides the options (label plus an optional one-line hint) and the selected value.

- The trigger is `ui` text in `fg-secondary` with a `border` edge and `radius-lg`, ending in a chevron.
- The menu is `surface-3` with `border`, `radius-lg` and `shadow-popover`; items are `radius-sm` rows that fill `surface-hover` when hovered or selected.
- Hints sit right-aligned in `caption` and `fg-subtle`.
- Use the same menu for row context menus (Rename, Pin, Archive, Delete), with Delete last in `danger`.
