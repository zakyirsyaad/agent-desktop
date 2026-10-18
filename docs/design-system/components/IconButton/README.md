# IconButton

A square icon-only button for toolbars, the composer and row actions.

In the app: `<IconButton label="…">` from `src/components/ui/IconButton.tsx`, which sets the `aria-label` and the tooltip from `label`. In previews: `<button class="z-icon-btn" aria-label="…">`. The consumer provides one Lucide icon and an `aria-label` that says what it does ("Close", "Open terminal").

- Ghost by default: `fg-muted`, filling `surface-hover` on hover.
- `z-icon-btn--primary` is the composer's Send button only: `primary` fill at `radius-lg`.
- Always `size-control` (28px) square, so rows of them line up.
- Show a tooltip with the same words as the `aria-label`.
