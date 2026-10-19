# Zorvo landing page

The marketing site for Zorvo: one page, built with Next.js and exported as
static HTML to `out/`. It shares the app's design tokens (`app/globals.css`
mirrors `src/styles/globals.css`, checked by `src/test/site.test.tsx`), its
fonts (`@fontsource-variable`) and its agent logos (`src/assets/agents/`).

```bash
pnpm install                      # from the repository root
pnpm --filter zorvo-site dev      # http://localhost:3100
pnpm --filter zorvo-site build    # writes site/out/
```

`out/` is plain files: any static host serves it. Next.js telemetry is off in
both scripts. The page makes no requests to other sites; downloads link to
the GitHub releases.

- Sections live in `components/sections/`, in page order in `app/page.tsx`.
- The pictures of the app (`components/mockups/`) are `role="img"` with a
  description; nothing inside them is focusable.
- Copy follows `docs/brand/zorvo-brand-brief.md`: sentence case, no
  exclamation marks or emoji, name the agents, never imply endorsement.
