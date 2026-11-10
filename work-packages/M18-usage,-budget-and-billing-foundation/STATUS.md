# M18 Status - Usage, Budget & Billing Foundation

- **State:** INTEGRATED (PR #31 squash-merged to `main`; docs-only closeout records it)
- **Assigned session/editor:** Module Implementation Agent, Desktop (TRACXN-LP-784), local session (no cloud agent)
- **Branch/worktree:** `work/m18-usage-budget-and-billing-foundation` from `origin/main` `6e4f2965f3b3c6d4097eae2153bf9874b2d99a63` (M16 closeout); worktree `/home/tracxn-lp-784/Desktop/project/reelforge-m18`, built in parallel with M17
- **Last updated:** 2026-11-10 (review 5839788708 fixes, merged with origin/main `f0feccd`)
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** `6c49a4b878126e3d1a3639d1db4ab0db8944c79c` (review `5842769674`, APPROVED by `minu-the-reviewer`)
- **Merged commit:** `7e862fec80e5f7524ecc6cfdc0ef62165a410e5e` (squash-merged by `minu-the-reviewer` on 2026-11-10)

## Current objective
Control provider spending and expose transparent per-channel usage.

## Completion estimate
Implemented, reviewed, and integrated via PR #31. Residual notes below are non-blocking follow-ups.

## Task checklist
- [x] M18-T01: Usage categories `LLM`, `TTS`, `IMAGE_MEDIA`, `RENDER`, `PUBLISH`, `ANALYTICS_API`, plus `UNCATEGORIZED` for ledger rows whose capability can't be mapped. Usage is read from the EXISTING M08 ledger (`provider_requests`) through read-only joins (`usage-budget.ledger.ts`). M18 records no provider spend of its own.
- [x] M18-T02: Daily and monthly limits per workspace and optionally per channel, as integer minor units (`BIGINT`) plus an ISO 4217 currency, with no floats. Periods are calendar days or months in the channel timezone (channel budgets) or the budget's timezone (workspace budgets, default UTC), with DST handled. Preflight `reserve` → `commit(actual)` / `release`. Reservations expire (default TTL 15 min, max 24 h). Expired reservations stop counting at `expiresAt`, and the expiry sweep marks them `EXPIRED`. Reservations are idempotent per `(workspaceId, idempotencyKey)`.
- [x] M18-T03: Hard stop. `reserve` throws the typed `BudgetExhaustedError` (`code: BUDGET_EXHAUSTED`, HTTP 409). Nothing in M18 catches it. The M16 adapter returns `BLOCKED/BUDGET_EXHAUSTED`, which M16 enforces for both manual and scheduled runs. With no budget configured, the result is `NOT_CONFIGURED/BUDGET_POLICY_UNAVAILABLE`: scheduled runs stay blocked (fail closed) and manual runs follow M16's existing rule.
- [x] M18-T04: Read-only dashboard API for VIEWER and above: totals by period and category, per-channel usage, a per-video (script) and per-job (workflow run) cost breakdown, and budget remaining. No web UI; the pack does not require one.
- [x] M18-T05: OWNER-only admin actions: budget create, limit change, and credit/debit corrections. Each writes one append-only `usage_audit_records` row with actor, reason, before, after, and correlationId. `usage_adjustments` and `usage_audit_records` reject UPDATE and DELETE through a database trigger; only a cascade from deleting the owning workspace can remove them.
- [x] M18-T06: No payment collection. `BillingProviderPort` is an interface only, bound to `NotConfiguredBillingProvider`, with no adapter and no dependency.

## Files changed
- Schema/migration (Core-approved additive): `packages/database/prisma/schema.prisma`. Four enums (`UsageCategory`, `UsageReservationStatus`, `UsageAdjustmentKind`, `UsageAuditAction`) and four models (`UsageBudget`, `UsageReservation`, `UsageAdjustment`, `UsageAuditRecord`) are appended at the end of the file, plus back-relation lines in `Workspace` (4) and `Channel` (1). The migration `packages/database/prisma/migrations/20261117010000_m18_usage_budget_and_billing/migration.sql` adds the tables, indexes, CHECK constraints (currency format, non-negative minor units, scope key, commit consistency), and the append-only triggers. `packages/database/src/index.ts` exports the four enums.
- API module (new): `apps/api/src/modules/usage-budget/` contains `usage-budget.{types,money,time,ledger,totals,validation,service,policy,billing,controller,module}.ts`.
- Tests (new): `usage-budget.time.test.ts`, `usage-budget.service.test.ts` (unit), `usage-budget.postgres.integration.test.ts` (skipped without `DATABASE_URL`).
- Registration: `apps/api/src/app.module.ts` (`UsageBudgetModule`).
- Approved cross-module edit: `apps/api/src/modules/orchestration/orchestration.module.ts` now imports `UsageBudgetModule` and binds `WORKFLOW_BUDGET_POLICY` with `useExisting: UsageBudgetPolicy` in place of `UnconfiguredBudgetPolicy`. That is the only M16 change. `UnconfiguredBudgetPolicy`/`StaticBudgetPolicy` stay for M16 tests, and the `BudgetPolicyPort` contract is unchanged.
- Docs: this file and `docs/WORK_LOG.md`. `PROJECT_STATE.md`, `ci.yml`, `package.json` files, and the lockfile are untouched. No new dependency.

## API
`/api/v1/workspaces/:workspaceId/usage`:
- `GET summary?period=DAY|MONTH&date=YYYY-MM-DD&channelId=&timezone=` returns totals per currency and category (actual / estimated / reserved / committed / adjustment net, ledger request counts, unknown-cost count), `categoriesWithoutLedgerSource`, and the applicable budgets with remaining amounts.
- `GET channels?period=&date=&timezone=` returns per-channel totals (plus an unassigned `channelId: null` bucket) and each channel budget's status.
- `GET videos/:scriptId` returns the per-video breakdown: ledger line items with cost kind, reservations, workflow run ids, render jobs (`NOT_TRACKED`), and budgets.
- `GET runs/:runId` returns the per-job (M16 run) breakdown.
- `GET budgets` returns budget status per period (limit, consumed, remaining, exhausted).
- `PUT budgets` (OWNER) creates a budget or changes its limits. `expectedVersion` gives optimistic concurrency. Currency is immutable.
- `POST adjustments` (OWNER) records a CREDIT or DEBIT correction.
- `GET audit` returns the latest 200 audit records.

Reads are open to every member (VIEWER and above). Non-members get 403 from `WorkspaceService.context`, and other tenants' ids return 404. Reservations (`reserve`, `commit`, `release`, `sweepExpiredReservations`) are an in-process API on `UsageBudgetService` (exported) and have no HTTP surface.

## Core decisions applied / made in this session
1. **Budget consumption** = the M08 ledger spend in the period and scope (actual cost; else the estimate for succeeded, still-pending, **and failed-after-dispatch** calls; only rows M08 marks as provably never dispatched are skipped) + live reservations + committed reservations + debits − credits. Ledger rows whose correlation id belongs to a live or committed M18 reservation are excluded, so nothing is counted twice.
2. **Atomic guard:** `reserve` takes `SELECT … FOR UPDATE` on every applicable budget row (workspace and channel, in id order), re-checks idempotency and limits under the lock, then inserts. Concurrent reservations serialize per budget. A unique `(workspace_id, idempotency_key)` index is the backstop.
3. **Rounding:** ledger decimals are converted to minor units with the ISO 4217 exponent (0/2/3) and rounded **up**, so fractional costs are never under-counted.
4. **No FX:** spend in a currency other than the budget's makes the budget unresolvable. `reserve` throws `BUDGET_CURRENCY_MISMATCH` and the policy returns `BLOCKED`. This fails closed rather than ignoring spend.
5. **Commit after expiry is allowed** (EXPIRED → COMMITTED) so real spend is never hidden. A released reservation cannot be committed, and a committed one cannot be released.
6. **Workspace budget timezone:** the `workspaces` table has no timezone column, so a workspace budget stores its own IANA timezone (default UTC). A channel budget always follows the channel's current timezone.
7. **The M08 `provider_budgets` daily guard is left as is.** It remains M08's per-call provider guard. M18 budgets are the workspace/channel policy layer above it, and every M08 paid call now also reserves through M18 first (B1).

## Review 5839788708 fixes
- **B1, paid M08 calls reserve through M18** (Core-approved cross-module edit). `ScriptModule` and `SceneMediaModule` import `UsageBudgetModule` (no cycle). Before each provider call, `UsageBudgetService.reservePaidCall` (`usage-budget.service.ts`) reserves the call's estimate with idempotency key `m08:<correlationId>` and the call's correlationId. It runs **before** the M08 ledger row is written; otherwise the call's own PENDING row (counted at its estimate) would be charged twice during its own preflight, and two concurrent calls at the limit would both be refused.
  - `BUDGET_EXHAUSTED` / `BUDGET_CURRENCY_MISMATCH` / `BUDGET_TIMEZONE_INVALID` (409) stop the call before the provider. No M08 hold or ledger row exists yet, so nothing needs releasing. `ScriptService.generate` rethrows the 409. Scene media keeps its per-output failure model: the output fails `FAILED_RETRYABLE` with that code.
  - `NOT_CONFIGURED` proceeds (M16 manual rule). A preflight that itself fails is `NOT_DISPATCHED` (503). A replayed correlation id is `PAID_CALL_REPLAYED` (409). Every one of these means the provider is not called.
  - `finishPaidCall` commits a dispatched call at the actual cost (when reported in the reservation currency), else at the estimate. It releases only a call that was never dispatched (for example, the M08 daily guard refused after the M18 hold). It never throws: if the write fails, the hold expires and the ledger row counts again.
  - When the M08 daily guard refuses, the PENDING ledger row it already committed is now marked `FAILED/NOT_DISPATCHED` with `dispatched:false`.
- **B2, failed calls are charged at their estimate.** `classifyCost` returns `FAILED_ESTIMATED` ("failed, charged at estimate") for a FAILED row with no actual cost. Only rows whose errorCode is in `PRE_DISPATCH_ERROR_CODES` (`NOT_DISPATCHED`, `BUDGET_EXHAUSTED`, `BUDGET_CURRENCY_MISMATCH`, `BUDGET_TIMEZONE_INVALID`) are `NOT_DISPATCHED` and skipped. Totals have `failedEstimatedMinor` / `failedEstimatedRequests` per category and currency plus a `notDispatchedRequests` count. Cost lines carry `costKind` and `costKindLabel`. An OWNER can correct a provider that did not bill with an audited CREDIT.
- **M16 scheduler:** if the budget policy throws, `runSchedulerTick` marks the slot `SKIPPED` with reason `BUDGET_POLICY_ERROR` instead of leaving it CLAIMED with no run.
- **Optional unique index (done):** a partial unique index `usage_reservations(workspace_id, correlation_id) WHERE correlation_id IS NOT NULL`, added to the same M18 migration (not yet applied anywhere but disposable DBs). It is SQL-only because Prisma cannot express a partial index. A second key for the same correlation id returns 409 `CORRELATION_ALREADY_RESERVED`.
- **Optional M16 PAUSE on BUDGET_EXHAUSTED: not done.** A script step refused by M18 still surfaces through M16's existing 4xx mapping (`DOMAIN_REJECTED_409`, run FAILED). This is left as a follow-up so M16 run semantics are not changed in this PR.

## Currency-mismatch recovery
M18 has no FX. A budget becomes unresolvable (`BUDGET_CURRENCY_MISMATCH`, so reserve fails and the policy BLOCKS) when:
- a reservation is requested in another currency (for example a USD-priced provider against an INR budget), or
- ledger spend in another currency exists in the budget's scope.

Budget currency is immutable. To recover, an OWNER either:
1. deletes the budget and recreates it in the currency the providers bill in (the old audit trail stays); or
2. keeps the budget and waits for an FX/conversion feature (not in M18).

Until then, paid calls in that scope stay refused, which is the fail-closed outcome.

## M08 ledger join gaps (documented, never invented)
- **No video id on the ledger.** The script id is used as the video key. Scene-media calls join through `scene_generation_outputs.correlation_id` → scene generation → `scene_media_jobs.script_id`. Script LLM calls join only when they ran inside an M16 run (the script call carries the run correlation id, and the run's `SCRIPT` step `result_ref` gives the script id). A script generated outside M16 has no ledger link to its script (`script_revisions` stores cost but no correlation id), so it appears in workspace/channel totals but not in the per-video breakdown.
- **No job id on the ledger.** The job (M16 run) is joined via `workflow_runs.correlation_id` for script calls and via the `SCENE_MEDIA_PACKAGE` step `result_ref` for scene media.
- **No provider kind column.** The category comes from the scene output kind (IMAGE/VIDEO → IMAGE_MEDIA, NARRATION/DIALOGUE → TTS), else from capability/provider id keywords, else `UNCATEGORIZED`.
- **RENDER, PUBLISH, ANALYTICS_API have no ledger source.** Render is local FFmpeg, and M13/M14 API calls are not costed by M08. These categories show only reservations and adjustments recorded explicitly; the summary lists them in `categoriesWithoutLedgerSource`, and render jobs appear as `NOT_TRACKED`.
- `ideas.cost`, `script_revisions.cost`, and `performance_insight_reports.cost` are not ledger rows and are not added, to avoid double counting.
- `provider_requests.channel_id` is nullable. Rows without a channel count toward the workspace budget only and show in the unassigned bucket.

## Commands and evidence
Run in the worktree with Node 24.22.2 / pnpm 12.16.1, `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55439/reelforge` (disposable `reelforge-m18-db`, postgres:18.6-alpine) and, for the Redis suite, `REDIS_URL=redis://127.0.0.1:56381` (disposable `reelforge-m18-redis`).
- `pnpm install --frozen-lockfile`: passed (lockfile up to date).
- `pnpm lint`: passed (exit 0).
- `pnpm format:check`: passed ("All matched files use Prettier code style!").
- `pnpm typecheck`: passed (exit 0).
- `pnpm test` with `REDIS_URL`: **62 files passed / 1 skipped; 428 tests passed / 5 skipped** (the 5 FFmpeg skips). In 22 Redis-enabled full runs, 18 were fully green. 4 had exactly one failure, always the existing M08 test `script.integration.test.ts > keeps a prior-day response auditable across reset without charging the new day`, which waits a fixed 25 ms (`setTimeout(…, 25)`) before advancing its clock and can lose that race under full-suite parallel load (`Provider daily budget exceeded` instead of `next day fails`). M18 does not touch `ScriptService`, `provider_budgets`, or that test file. The flake is recorded here and left for its owning module.
- `pnpm test` without `REDIS_URL`: 61 files passed / 2 skipped; 425 tests passed / 8 skipped (5 FFmpeg + 3 Redis).
- M18 module alone (`vitest run apps/api/src/modules/usage-budget`): 3 files, 24 tests passed (11 Postgres integration + 13 unit), stable across repeated runs.
- `pnpm build`: passed (exit 0).
- `pnpm db:validate`: "The schema at prisma/schema.prisma is valid".
- `pnpm db:migrate:deploy` on a fresh database (`reelforge_fresh` on 55439): "25 migrations found … All migrations have been successfully applied."
- HTTP smoke of the built API on `PORT=3006`: `/health` 200; unauthenticated `/usage/summary` 401; register → create workspace → `GET budgets` `[]` → `PUT budgets` 200 → float limit 400 → `POST adjustments` 200 → `summary`/`channels` 200 → `audit` 2 records → unknown script 404.

Integration coverage (`usage-budget.postgres.integration.test.ts`): NOT_CONFIGURED path; concurrent reservations at the limit (2 racing clients → exactly one wins; burst of 8 → exactly one); commit and release (idempotent, illegal transitions 409, cross-tenant 404); expiry and sweep; idempotent reserve (concurrent same key → one row; key reuse with a different body → 409); hard stop from ledger spend plus DEBIT/CREDIT adjustments and the currency-mismatch fail-closed path; OWNER-only admin with audit before/after/correlationId and append-only enforcement at the database level; VIEWER read and cross-tenant denial; Asia/Kolkata day and month boundaries; ledger joins to channel, video, run and category with no double counting; and M16 integration with the real adapter (scheduled slot SKIPPED `BUDGET_POLICY_UNAVAILABLE` when unconfigured, manual allowed; STARTED under budget; SKIPPED `BUDGET_EXHAUSTED` and manual refused when exhausted).

## Contract/schema proposals
- Additive migration `20261117010000_m18_usage_budget_and_billing` (Core-approved name). No changes to existing tables beyond the new FKs that reference `workspaces` and `channels`.
- No `packages/contracts` change: the response types are module-local.

## Blockers / risks / unknowns
- Resolved in the review fixes: M08 paid calls now reserve through M18 under the budget row lock before dispatch (B1).
- A paid call made while no budget applied (NOT_CONFIGURED) has no M18 hold. If a budget is created mid-call, that call's ledger row counts at its estimate once it is recorded.
- The expiry sweep runs inside every `reserve` (for that workspace) and is callable as `sweepExpiredReservations`. It is not yet on a worker tick, because that needs `apps/api/package.json` exports and a `apps/worker/src/main.ts` edit. Correctness doesn't depend on it, since expired reservations stop counting at `expiresAt`.
- The policy evaluates "exhausted" as consumed ≥ limit for any configured period; it does not estimate a run's cost in advance.
- M17 (PR #32, `f0feccd`) is merged into this branch with a merge commit (no rebase, no force-push). Conflicts were in `app.module.ts`, `schema.prisma` (`Workspace` back-relations and the end-of-file model blocks) and `docs/WORK_LOG.md`; each kept both sides, M17 first then M18. `packages/database/src/index.ts` and `orchestration.service.ts` auto-merged. Migration `20261117010000_m18…` sorts after M17's `20261116010000_m17…`, and both apply in that order on a fresh database.
- Existing M08 timing flake: `script.integration.test.ts > keeps a prior-day response auditable…` waits a fixed 25 ms and can lose the race under full-suite load. It passes 5/5 in isolation and is left for its owning module.

## Review-fix verification (after merging origin/main `f0feccd`)
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm db:validate`: all passed.
- `pnpm db:migrate:deploy` on a fresh database: 26 migrations found; `20261116010000_m17_notifications_and_reporting` then `20261117010000_m18_usage_budget_and_billing` applied.
- `prisma migrate diff` (fresh DB → schema): no M17 or M18 objects differ. The remaining lines are drift from earlier modules (FK names and defaults) that this branch does not touch.
- `pnpm test` with `REDIS_URL`: **68 files passed / 1 skipped; 466 tests passed / 5 skipped** (FFmpeg). One other run had a single failure, the known M08 25 ms flake above; the rerun was green.
- M18 module alone: 4 files, 33 tests (14 unit, 13 Postgres, 6 M08 paid-call integration). Scene-media unit tests: 21, including 2 new B1 tests.

## Next exact action
None for M18 product work. M17 and M18 are integrated; M19 is next after the docs-only closeout merges.

## Handoff notes
Containers `reelforge-m18-db` and `reelforge-m18-redis` were disposable and are removed after verification. `.local-data/` holds the command log and progress file and is gitignored.

## Reviewer decision
- Round 1: REQUEST_CHANGES at `e8533ac3209b6e16e3122fa8ff77ab37c6a7fcec` (review `5839788708`, B1–B2 plus the scheduler policy-error fix).
- Round 2: APPROVED at `6c49a4b878126e3d1a3639d1db4ab0db8944c79c` (review `5842769674`) after the fix-forward commits and the merge of `origin/main` (M17).
- Integration: squash-merged to `main` by `minu-the-reviewer` at `7e862fec80e5f7524ecc6cfdc0ef62165a410e5e` (PR #31) on 2026-11-10. State set to INTEGRATED by the docs-only closeout PR; no product rework.

## Carried residual notes (non-blocking)
- The scene-media budget path needs a Postgres integration test.
- Not-dispatched calls are detected by error code; use the ledger's dispatched flag instead.
- The partial unique index on `usage_reservations(workspace_id, correlation_id)` exists only in the migration SQL, not in `schema.prisma`. Watch `migrate diff`.
- A generic reserve that reuses a correlation id under a different key returns 500 instead of 409.
- The M16 run correlation id blocks a second paid script call in the same run, so retries need a new correlation id per attempt.
- A failed finish-hold expires after 60 minutes.
- M16 fails over-budget runs instead of pausing them.
- The expiry sweep is not on a worker tick.
- Ledger gaps: no video/job id, heuristic category, no RENDER / PUBLISH / ANALYTICS source.
- Currency mismatch is a permanent block. The recovery in "Currency-mismatch recovery" above (delete and recreate the budget, or wait for FX) is carried forward unchanged.
- Workspace budgets default to UTC.
- Each check rescans the ledger.
- The append-only trigger allows deletes too broadly.
- The M08 25 ms prior-day test is flaky under full-suite load.
