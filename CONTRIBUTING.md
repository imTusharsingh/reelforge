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

A Husky pre-commit hook runs Oxlint `--fix` and Oxfmt on staged files only, via lint-staged. Auto-fixable issues are applied and re-staged; unfixable Oxlint errors fail the commit. The hook does not run typecheck or tests. CI (`pnpm lint` and `pnpm format:check`) remains the real gate, because the hook can be skipped with `--no-verify`. If lint-staged is not installed in the current worktree, the hook prints a warning and allows the commit.

## Scope and review

Keep changes within the assigned work package. Shared contracts, schema, migration order, and root configuration require Core Reviewer ownership. Do not claim approval or merge your own PR. Record exact command results and changed files in the assigned status report and append a dated `docs/WORK_LOG.md` entry.

The optional **Full suite reliability** GitHub Actions workflow runs the entire
offline suite three times per mode. Select it under Actions and use Run workflow.
The modes use PostgreSQL alone, PostgreSQL with Redis, and PostgreSQL with FFmpeg.
Each job publishes the output of all three attempts.

Set `REELFORGE_API_ORIGIN` to the API's explicit HTTP(S) origin for a production
web build. The manual text smoke also requires an explicit `OPENAI_TEXT_MODEL`.
Account email prefers Resend when both `RESEND_API_KEY` and `ACCOUNT_EMAIL_FROM`
are usable. Set the sender to a single email address or a `Name <email>` value.
The Resend test sender delivers only to the verified owner mailbox until you
verify a sending domain and use a sender on that domain. See [Resend's test sender
restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

When either Resend setting is missing or invalid, account email uses the generic
HTTPS relay if `ACCOUNT_EMAIL_RELAY_URL` and `ACCOUNT_EMAIL_RELAY_TOKEN` are valid.
The relay accepts an authenticated JSON POST containing `to`, `purpose` and a
one-time `code`. Deliver the code in the email body for the recipient to paste
into the account form. Never log codes, API keys, Authorization headers, or raw
request or response bodies that may contain them.

When neither provider is configured correctly, issuance endpoints return HTTP
503 for all callers. Reset requests enter a PostgreSQL queue before account lookup. The
API worker retries delivery failures up to four attempts, expires queued requests
after ten minutes, and removes the queued code on completion. The relay should
treat repeated delivery of the same code as a retry. Keep the queue database
restricted to the same operational access as credential storage. Set
`API_TRUSTED_PROXIES` to the proxy IPs or CIDRs if traffic is proxied. Only those
peers can supply client addresses for source limits.

Planning uses session advisory locks. Point `DIRECT_DATABASE_URL` at PostgreSQL
or a session-mode endpoint if `DATABASE_URL` uses a transaction-mode pooler.

Run `pnpm format` to format the workspace. Keep one blank line between functions and around distinct groups of variables when it helps the reader. Oxfmt preserves intentional single blank lines without sorting imports or package keys. See [the toolchain decisions](docs/TOOLCHAIN.md).
