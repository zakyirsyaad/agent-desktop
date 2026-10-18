# Final fix report

1. index.html: removed `bg-[#0a0a0a] text-neutral-100` from body. design-tokens.test.ts now scans index.html with rawColorsIn(). Confirmed: temporarily restored the old classes, the new test failed (matches "text-neutral-100", "-[#0a0a0a"), then reverted.
2. ComposerDock.tsx: removed inline boxShadow style; shadow-popover applies.
3. Button.tsx / IconButton.tsx: hover utilities now `enabled:hover:`. ui-primitives test asserts `enabled:hover:bg-primary-hover` present and `hover:bg-primary-hover` absent.
4. motion-reduce:animate-none added to ToolCallList running badge and TerminalDrawer live dot.
5. FolderStep.tsx: path uses text-fg-muted when selected, text-fg-subtle otherwise.
6. Sidebar.tsx: search input uses border-border-strong.

Verification:
- pnpm lint: tsc + eslint clean.
- Focused tests: 6 files, 73 passed.
- Full suite (--testTimeout=60000 --maxWorkers=2): 668 passed, 0 failed.
- pnpm build: built OK; `grep -c '\[\\#' dist/assets/*.css` = 0.
