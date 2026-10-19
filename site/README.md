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

`out/` is plain files: any static host serves it.

## Deploying on Vercel

Import the repository in Vercel and set **Root Directory** to `site`. The
rest comes from `vercel.json`: install and build with pnpm 12 (the version
the workspace's settings need), security headers including a CSP that only
allows the site's own origin, and a skipped build when a commit touches
nothing the site uses.

The canonical URL, sitemap and Open Graph links use `SITE_URL` if set,
otherwise Vercel's production domain, so adding a custom domain in Vercel
moves them with it. Next.js telemetry is off in
both scripts. The page makes no requests to other sites; downloads link to
the GitHub releases.

- Sections live in `components/sections/`, in page order in `app/page.tsx`.
- The pictures of the app (`components/mockups/`) are `role="img"` with a
  description; nothing inside them is focusable.
- Copy follows `docs/brand/zorvo-brand-brief.md`: sentence case, no
  exclamation marks or emoji, name the agents, never imply endorsement.
