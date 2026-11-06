# M08 Status - AI Provider Registry & Cost Ledger

- **State:** INTEGRATED
- **Assigned session/editor:** Module Implementation Agent
- **Branch/worktree:** `main` (PR #16)
- **Last updated:** 2026-11-06
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** `e1f20d34e13f3f9d00cc6d43f8c9e046f8af2896`
- **Merge commit:** `2d6d70379bf197d4db06c947077fa951b94d739f`

## Current objective
Expose provider-neutral AI capabilities and record real provider use and costs.

## Task checklist
- [x] M08-T01: Provider-neutral LLM, image, video, and TTS interfaces.
- [x] M08-T02: Capability and cost metadata.
- [x] M08-T03: Registry and non-secret credential boundary.
- [x] M08-T04: Normalized fail-closed error taxonomy.
- [x] M08-T05: Persisted provider request ledger around script dispatch, including failure metadata.
- [x] M08-T06: Persisted workspace/channel caps with atomic reservation before dispatch; missing budgets and over-capacity fail closed.
- [x] M08-T07: Explicit authenticated provider-health operation; no startup/CI invocation and unconfigured adapters fail closed.


## Files changed
- `apps/api/src/modules/script/**`: preflight estimate, complete post-dispatch success/failure ledger, exact prompt, actual/unknown cost settlement, durable reservations.
- `packages/database/prisma/**`: additive migration `20261106170000_m07_m08_provenance_and_reservations`.

## Commands and evidence
- Node `24.22.2`; `pnpm install --frozen-lockfile` — **PASSED**.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm db:validate` — **PASSED**.
- `pnpm db:migrate:deploy` — **PASSED** on a new local PostgreSQL database; 11 migrations applied in order, including the additive provenance/reservation migration.
- `pnpm test` — **PASSED**, 25 test files / 138 tests. Focused script suites: 5 files / 36 tests.
- `pnpm build` — **PASSED** for all packages/apps.
- `git diff --check` — **PASSED**.
- Persisted tests cover tenant isolation/FKs, atomic daily-cap concurrency, failure release, known actual-cost settlement, unknown-cost settlement, malformed output/envelopes (missing, null, and non-object metadata), invalid provenance, script persistence failure, and cross-day reservation behavior.

## Contract/schema proposals
- Additive request/reservation correlation FK and persisted reservation state; no destructive migration or prior applied migration rewrite.

## Blockers / risks / unknowns
- Unknown provider cost is conservatively charged at the preflight estimate but remains `actualCost=null` and `costKnown=false`; it is not represented as a measured actual.
- Cross-day settlement does not charge/reset two different daily windows; the original reservation retains cost and `budgetApplied=false` for reconciliation.
- Integrated by squash merge of PR #16. No live provider call or production readiness is claimed by that merge. Failure to persist the database ledger itself remains an infrastructure limitation, not a silently claimed successful ledger write.
- Prior documented Prisma compiled-dist ESM boot follow-up remains open and was not part of PR #16.

## Next exact action
None for M08. M09 is the next sequential package and is pending Minu review. Do not start M10 from this module.

## Handoff notes
Success `estimatedCost` is always the preflight estimate. Post-dispatch validation and persistence failures settle a received provider response; exceptions thrown before a response release the reservation. Provider health remains explicit-only and the runtime registry remains fail-closed.

## Reviewer decision
- Approved by Minu at `e1f20d34e13f3f9d00cc6d43f8c9e046f8af2896` and integrated by squash merge `2d6d70379bf197d4db06c947077fa951b94d739f` (PR #16).
