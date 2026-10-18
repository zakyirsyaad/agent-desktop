# Adopting in the app

This migration landed in #35 (dark) and #36 (light). The tables stay as the record of what each old class became and why some values changed.

How the classes the app uses today map onto this system. Replace each class with its token through Tailwind v4's `@theme`, so a theme change is one file, not forty components.

## Colors

| Today | Token |
|---|---|
| `bg-[#000000]`, `bg-[#0a0a0a]`, `--color-bg-base` | `bg` |
| `bg-[#0d0d0d]`, `--color-bg-subtle` | `surface-1` |
| `bg-[#121212]`, `bg-[#141414]`, `bg-neutral-900`, `--color-bg-surface` | `surface-2` |
| `bg-[#181818]` (menus) | `surface-3` |
| `hover:bg-neutral-800`, `hover:bg-neutral-900`, `bg-neutral-800` (selected) | `surface-hover` |
| `bg-black/70` | `overlay` |
| `border-[#262626]`, `border-neutral-800`, `border-neutral-800/60`, `/80`, `/40` | `border` |
| `border-neutral-700`, `ring-neutral-700` (as an edge) | `border-strong` |
| `text-neutral-100`, `--color-text-main` | `fg` |
| `text-neutral-200`, `text-neutral-300` | `fg-secondary` |
| `text-neutral-400`, `--color-text-muted` | `fg-muted` |
| `text-neutral-500`, `text-neutral-600`, `placeholder-neutral-500` | `fg-subtle` |
| `bg-neutral-200 text-neutral-900 hover:bg-white` | `primary`, `on-primary`, `primary-hover` |
| `focus:ring-amber-500/40`, `focus:ring-neutral-700` | `focus-ring` |
| `text-emerald-400`, `bg-emerald-500` | `status-running` |
| `text-amber-400`, `text-amber-500`, `bg-amber-400` | `status-attention` |
| `bg-sky-400` | `status-unread` |
| `text-red-400`, `text-rose-300` | `danger` |
| `bg-rose-950/70` | `danger-surface` |
| `border-l-4 border-l-amber-500 bg-[#141414]` (permission card) | `attention-surface` + `attention-border` on all sides |

## Intentional changes

These differ from today's app on purpose:

- **Hints get lighter.** `text-neutral-500` measured 3.1–4.2:1 on the dark surfaces, under the 4.5:1 floor for small text. `fg-subtle` is 4.9–5.9:1.
- **Focus is neutral and solid.** The faint amber ring (`ring-amber-500/40`) is replaced by a solid `focus-ring` that reaches 5.8:1 or more. Amber now only means "waiting on you".
- **Permission cards lose the colored left edge** for a full `attention-border` and an `attention-surface` fill.
- **Zinc instead of neutral.** The grays take zinc's faint cool tint, matching the brand brief.
- **Fonts.** The system font stack becomes Instrument Sans; the terminal and code move from Menlo to Geist Mono.

## Fonts in the app

Bundle `InstrumentSans` (400, 500, 600) and `GeistMono` (400) as `.woff2` under `src/assets/fonts/` and declare them with `@font-face`. The app's Content Security Policy does not allow `fonts.googleapis.com`, so linking Google Fonts works in development and fails in the release build.
