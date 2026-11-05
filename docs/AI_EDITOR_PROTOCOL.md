# AI Coding-Editor Protocol (Platform Independent)

This protocol applies to Codex, Claude Code, Cursor, GitHub Copilot, Windsurf, or any other coding editor. Tool names differ; the rules do not.

## 1. Roles

### Project Owner

Owns product priorities, approves scope changes, provides accounts/credentials, sets spend limits, and authorizes live external side effects.

### Core Architect / Reviewer session

The single source-of-truth coordinator. It reads the complete project docs, assigns/accepts work packages, freezes shared contracts, reviews implementation evidence, resolves cross-module conflicts, merges approved shared changes, updates master history, and decides whether a block is integrated. It may delegate module implementation but does not assume a module is correct because another AI says so.

### Module implementation session

One session is assigned exactly one work package. It inspects current repo state, implements only that scope, runs relevant offline checks, documents evidence, and prepares a review handoff. It does not approve itself.

## 2. One block = one session = one branch/worktree

- Use a separate branch and preferably a separate Git worktree for every block.
- One coding session must not implement two work packages at once.
- Never have two sessions editing the same files or branch concurrently.
- Shared contracts/schema/root configuration are Core-owned. Module bots submit proposals instead of editing them.
- The Core Reviewer integrates sequentially and resolves conflicts.
- A new chat/session must read `README.md`, `docs/PROJECT_STATE.md`, `docs/DECISION_LOG.md`, the assigned work package, and its `STATUS.md` before coding.

## 3. Required session start sequence

1. Confirm repository root and current branch/commit.
2. Read the source-of-truth docs listed above.
3. Read the assigned `WORK_PACKAGE.md` and `STATUS.md`.
4. Inspect relevant existing code; do not assume the repo is empty or matches a prior summary.
5. Report scope, dependencies, likely files, and any conflict/unknown to the Core Reviewer before broad changes.
6. Implement the smallest vertical task increment and keep changes within owned boundaries.

## 4. Positive instructions (what the bot MUST do)

- Treat repository files and approved decisions as authoritative, not model memory or earlier chat summaries.
- Verify symbols, files, packages, API contracts, schema fields, environment variables, and provider capabilities before using them.
- Prefer existing patterns over introducing new abstractions.
- Make the smallest change that satisfies an explicitly listed task.
- Use strict types and runtime validation at trust boundaries.
- Make state transitions explicit and enforce them server-side.
- Add tests for behavior, edge cases, permissions, tenant isolation, retries, and failures.
- Run actual commands and record exact results; distinguish not run, failed, skipped, and passed.
- Keep external side effects isolated behind provider/platform adapters.
- Persist idempotency, correlation IDs, provider job IDs, remote IDs, and cost metadata where applicable.
- Make failures observable and actionable; never silently swallow exceptions.
- Update the module `STATUS.md` and append a concise entry to `docs/WORK_LOG.md` before ending.
- Ask the Core Reviewer for a contract change when public interfaces or schema must change.
- If blocked, stop at the boundary, document the exact blocker, and do not invent a workaround.

## 5. Negative instructions (what the bot MUST NOT do)

- Do not invent files, functions, endpoints, API fields, environment variables, permission scopes, quotas, metrics, provider capabilities, or test results.
- Do not claim code is tested unless the command was executed and the output/result was observed.
- Do not add placeholder endpoints that return fabricated success.
- Do not add fake provider adapters, mock successful uploads, fake analytics, random generated data, or hardcoded demo responses to production code paths.
- Do not call live AI/social APIs merely to see whether credentials work. A live call is billable or externally visible and requires explicit owner authorization.
- Do not send real uploads/posts, publish publicly, change account settings, or spend credits without a separate explicit authorization for that exact action/account/budget.
- Do not run provider calls in app startup, migrations, seed scripts, health checks, CI, or unit tests.
- Do not weaken/remove tests, validation, authorization, hard gates, or error handling to make a build pass.
- Do not silently change architecture, dependencies, naming conventions, database schema, public contracts, event names, or release scope.
- Do not implement unrelated refactors or future features.
- Do not catch errors and return success-shaped objects.
- Do not use `any` as an escape hatch without a documented, narrow reason.
- Do not put secrets, tokens, personally identifying data, raw provider responses with sensitive fields, or signed URLs into logs or docs.
- Do not use browser automation or password collection to publish to a social account; use official API/OAuth flows only.
- Do not mark a task `APPROVED`, `INTEGRATED`, or `DONE`; only the Core Reviewer can do that.

## 6. No-fake/no-live-call development rule

Interpret this rule precisely:

**Production behavior must be real, not simulated.** A runtime provider adapter must call the real configured provider and normalize its actual response, or fail clearly because configuration/capability is unavailable. It must never return a fabricated asset, post ID, metric, or success status.

**Ordinary development and CI must not trigger external side effects.** Unit tests use deterministic local fixtures/fakes at the test seam; these are test artifacts and must never be packaged as runtime providers or presented as proof that an integration works. Contract tests validate schemas without network calls. Integration tests run against local infrastructure and fixture files.

**Live verification is a separate owner-authorized operation.** Before a live call, record provider/platform, account, exact operation, expected charge/quota, target visibility (private/unlisted/public), maximum spend, and rollback/cleanup plan. It must be explicitly invoked by an operator, never on startup/CI. A live result is evidence only for the exact capability tested.

No fake/test API call should be made to a user's real account as ordinary development work.

## 7. Definition of module completion

A module is ready for review only when:

- All in-scope tasks are implemented or explicitly marked blocked with owner decision needed.
- Acceptance criteria have evidence.
- Unit and contract tests pass.
- No unauthorized shared-file edits exist.
- No secrets or fake production paths exist.
- Public interfaces and DB changes are documented.
- Module status and work log are current.
- A handoff is written for a new session.

The reviewer may reject the work even when the bot reports completion.
