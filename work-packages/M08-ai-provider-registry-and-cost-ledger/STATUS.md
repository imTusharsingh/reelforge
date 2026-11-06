# M08 Status - AI Provider Registry & Cost Ledger

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Module Implementation Agent
- **Branch/worktree:** `work/m07-m08-combined`
- **Last updated:** 2026-11-06
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** none

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
- `packages/ai-providers/src/index.ts`, `apps/api/src/modules/script/**`, and additive migration `20261106160000_m07_m08_script_provider`.

## Commands and evidence
- `DATABASE_URL=... pnpm --filter @reelforge/api typecheck` — **PASSED**.
- `DATABASE_URL=... pnpm db:validate` — **PASSED**.
- `pnpm lint` — **PASSED**.
- `pnpm format:check` — **PASSED**.
- `pnpm test` — **PASSED**, 21 files / 104 passed / 2 skipped.
- `DATABASE_URL=... pnpm --filter @reelforge/api build` — **PASSED**.
- Root `pnpm typecheck` — **NOT COMPLETED within the command window**; API/database generation and API typecheck passed.
- Root `pnpm build` — **NOT RUN after this fix-forward**; API build passed on the prior head.
- `pnpm install --frozen-lockfile` — **NOT RUN after blocker changes**; prior attempt failed on Node 24.16.0 vs pinned 24.22.2.
- `pnpm db:migrate:deploy` — **FAILED** with local PostgreSQL authentication error `P1000`.

## Contract/schema proposals
- None.

## Blockers / risks / unknowns
- None recorded. Do not infer this means no risks exist; update after inspection.

## Next exact action
Read the work package and repository state, then report any conflict with existing code before implementation.

## Handoff notes
Health is an explicit operation and requires a registered adapter health callback; no live adapter is configured in tests or startup.

## Reviewer decision
- Pending.
