# Logos

The double prompt symbol and the app icon. The SVGs are single-ink because an `<img>` cannot inherit color: use the `-ink` files (ink `#0a0a0b`) on light grounds and the `-paper` files (paper `#fafafa`) on dark grounds. In app code, inline the repository's `docs/brand/assets/zorvo-symbol.svg`, which strokes in `currentColor`.

- `zorvo-symbol-ink.svg`, `zorvo-symbol-paper.svg`: 32px and up.
- `zorvo-symbol-small-ink.svg`, `zorvo-symbol-small-paper.svg`: under 32px, no cursor, heavier stroke.
- `zorvo-app-icon.png`: the 512px macOS app icon, paper symbol on an ink squircle.

There is no wordmark file: set `zorvo` in the `wordmark` type style beside the symbol.
