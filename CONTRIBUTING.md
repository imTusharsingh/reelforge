# Contributing

## Before changing code

Read `README.md`, `docs/PROJECT_STATE.md`, `docs/DECISION_LOG.md`, the assigned work package, and its `STATUS.md`. Work on one assigned package and branch at a time. If repository instructions conflict, stop and ask the Core Architect/Reviewer.

## Quality gates

Install the pinned toolchain, then run:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:validate
```

`pnpm db:check-migrations` needs a local `origin/main` ref. Fetch it with `git fetch origin main:refs/remotes/origin/main`, or set `MIGRATION_BASE_REF` to the correct local mainline ref.

For migration validation against local PostgreSQL, set `DATABASE_URL` to a disposable local database and run `pnpm db:migrate:deploy`. Never point this command at production. Set `NEXT_TELEMETRY_DISABLED=1` when running the web build locally. Do not call AI or social providers from CI, startup, health checks, seeds, migrations, or ordinary tests.

## Pre-commit hook

A Husky pre-commit hook runs Prettier and ESLint `--fix` on staged files only, via lint-staged. Auto-fixable issues are applied and re-staged; unfixable ESLint errors fail the commit. The hook does not run typecheck or tests. CI (`pnpm lint` and `pnpm format:check`) remains the real gate, because the hook can be skipped with `--no-verify`. If lint-staged is not installed in the current worktree, the hook prints a warning and allows the commit.

## Scope and review

Keep changes within the assigned work package. Shared contracts, schema, migration order, and root configuration require Core Reviewer ownership. Do not claim approval or merge your own PR. Record exact command results and changed files in the assigned status report and append a dated `docs/WORK_LOG.md` entry.

The optional **Full suite reliability** GitHub Actions workflow runs the entire
offline suite three times per mode. Select it under Actions and use Run workflow.
The modes use PostgreSQL alone, PostgreSQL with Redis, and PostgreSQL with FFmpeg.
Each job publishes the output of all three attempts.

Set `REELFORGE_API_ORIGIN` to the API's explicit HTTP(S) origin for a production
web build. The manual text smoke also requires an explicit `OPENAI_TEXT_MODEL`.
Account recovery can use an HTTPS email relay configured through
`ACCOUNT_EMAIL_RELAY_URL` and `ACCOUNT_EMAIL_RELAY_TOKEN`. The relay accepts an
authenticated JSON POST containing `to`, `purpose` and a one-time `code`. Deliver
the code in the email body for the recipient to paste into the account form.
