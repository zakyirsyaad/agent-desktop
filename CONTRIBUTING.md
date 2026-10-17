# Contributing

Thanks for helping with Agent Desktop. Issues and pull requests are welcome.

## Reporting a bug

Open an issue with the **Bug report** template. The most useful details are:

- the app version, shown in the sidebar's footer;
- the agent and its version, for example `qwen --version`;
- what you did, what you expected, and what happened instead.

Never paste API keys, tokens or private transcripts. The app does not need any of them, and a bug report does not either.

## Setting up

You need macOS, Node.js 22+ with pnpm, and a stable Rust toolchain.

```bash
pnpm install
pnpm tauri dev
```

To have the fast checks run before each commit (types, ESLint and `cargo fmt`):

```bash
pnpm lefthook install
```

## Making a change

1. Branch off `main` (`feat/…`, `fix/…`, `chore/…`).
2. Write a failing test first, then make it pass.
   - Frontend tests live in `src/test/` and run with Vitest and Testing Library; Tauri's `invoke` is faked in `src/test/setup.ts`.
   - Rust tests sit in `#[cfg(test)]` modules and in `src-tauri/tests/`.
3. Run every check before pushing:

   ```bash
   pnpm lint
   pnpm test
   cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
   ```

4. Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org) form: `feat: …`, `fix: …`, `refactor: …`, `docs: …`, `test: …`, `chore: …`, `ci: …`.
5. Open a pull request with the template. Add a line under `Unreleased` in `CHANGELOG.md` when users would notice the change.

## Ground rules

- **No secrets in the app.** Agent Desktop never asks for or stores API keys or tokens. Agents sign in with their own tools, and GitHub data comes from the user's own `gh`.
- **Check paths in the backend.** Every path the UI sends to a Tauri command is checked against the user's known workspaces (`ensure_known_workspace`) before it is read or run.
- **Keep files small.** Prefer a focused hook or component over growing `App.tsx`.
