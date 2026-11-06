# M07 Status - Script & Storyboard

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Module Implementation Agent
- **Branch/worktree:** `work/m07-m08-combined`
- **Last updated:** 2026-11-06
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** none

## Current objective
Convert an approved idea into a structured script and scene plan.

## Task checklist
- [x] M07-T01: Versioned script document schema.
- [x] M07-T02: Scene schema.
- [x] M07-T03: Typed injectable LLM boundary with fail-closed runtime default.
- [x] M07-T04: Duration, uniqueness, and factual-source validation.
- [x] M07-T05: Persisted script revisions, manual edit, approval, and immutable export routes.
- [x] M07-T06: Factual claims require URL-backed sources.
- [x] M07-T07: Persisted provenance and approved snapshot identifiers.


## Files changed
- `apps/api/src/modules/script/**`: HTTP authorization tests, paired snapshot consumption, genre policy validation, atomic lifecycle operations, exact dispatched prompt provenance.
- `packages/database/prisma/**`: additive migration `20261106170000_m07_m08_provenance_and_reservations`.

## Commands and evidence
- Node `24.22.2`; `pnpm install --frozen-lockfile` — **PASSED**.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm db:validate` — **PASSED**.
- `pnpm db:migrate:deploy` — **PASSED** on a new local PostgreSQL database; 11 migrations applied in order, including the additive provenance/reservation migration.
- `pnpm test` — **PASSED**, 25 test files / 138 tests. Focused script suites: 5 files / 36 tests.
- `pnpm build` — **PASSED** for all packages/apps.
- `git diff --check` — **PASSED**.
- Actual HTTP integration verifies unauthenticated 401s, outsider 403s and viewer 403s for get/revise/approve/export/provider health; owner read is successful. Persisted concurrent approve/revise test yields exactly one lifecycle winner and exports the consistent approved revision.
- Exact provider request prompt equals successful revision prompt; generated revisions reference the owned coherent config/prompt pair with tenant-scoped FKs. Runtime envelope/provenance normalization leaves a complete failed request row for malformed provider responses instead of a secondary recorder `TypeError` or `PENDING` ledger.

## Contract/schema proposals
- The pending request initializes atomically with its budget reservation; reservations reference the tenant/correlation ledger row. This is additive and deployed in the migration above.

## Blockers / risks / unknowns
- Final Minu/core review is pending; no approval, integration, merge, live provider call, or production readiness is claimed.
- Prior documented Prisma compiled-dist ESM boot follow-up remains outside this fix-forward.

## Next exact action
Minu reviews the pushed fix-forward head on PR #16.

## Handoff notes
Genre `requiresSourceBackedClaims` now drives factuality and source validation. When required, claims must match approved snapshot references; URLs alone do not satisfy support. Runtime remains fail-closed. Provider health is explicit-only. Unknown provider cost remains null; conservative budget charging uses the preflight estimate. Cross-day completion retains audit data and records `budgetApplied=false` rather than changing the new daily counters.

## Reviewer decision
- Pending.
