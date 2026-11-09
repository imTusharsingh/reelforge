# M11 Status - Quality Assurance & Approval

- **State:** INTEGRATED
- **Completion:** 100% implementation; integrated after reviewer approval
- **Assigned session/editor:** Module Implementation Agent (Desktop)
- **Branch/worktree:** `main` (PR #20)
- **Last updated:** 2026-11-10
- **Reviewer:** Minu (Core Architect)
- **Approved commit:** `e61af2b92dd553faf96bb96850dcf37864a57a40` (review `5831183493`)
- **Merge commit:** `42e33c5476ca2f392db199c2db70569c899213d8` (Minu)

## Current objective
Provide workspace-scoped quality gates, structured review results, human decisions, and bounded regeneration requests. No publishing or provider-result mutation is implemented.

## Task checklist
- [x] M11-T01: Runtime-validated hard-gate result schema and five review score categories.
- [x] M11-T02: M10 manifest/integrity consumption and aspect, duration, codec, audio, and subtitle checks.
- [x] M11-T03: Script/genre/factuality policy checks and typed AI review with criterion evidence and limitations.
- [x] M11-T04: Pinned asset rights/provenance checks and required disclosure flags.
- [x] M11-T05: Workspace-scoped queue includes blocked runs; decisions are audited, current-run only, and revalidate rights/genre gates before approval.
- [x] M11-T06: Channel-configured score thresholds; failed hard gates always block approval and auto-approval.
- [x] M11-T07: Route-only scene/script/render requests constrained by failed gates; limits of three persist per script lineage and target across renders.

## API contract
- `POST /workspaces/:workspaceId/quality/runs` — evaluate a successful render job.
- `GET /workspaces/:workspaceId/quality/queue` — oldest 50 pending `REVIEW_REQUIRED`, `BLOCKED`, or legacy `AI_REVIEW_UNAVAILABLE` results.
- `GET /workspaces/:workspaceId/quality/runs/:runId` — retrieve the review result, gate summary, decision audit, and regeneration requests.
- `GET /workspaces/:workspaceId/quality/renders/:renderJobId/status` — latest non-superseded status and gate summary for M13.
- `POST /workspaces/:workspaceId/quality/runs/:runId/decision` — approve, reject, or request changes with a reason; hard-gate failures cannot be approved and mismatched regeneration routes require an audited override reason.
- Channel `approvalPolicy` accepts `mode` (`MANUAL` or `AUTO`), `scoreThreshold` (integer 0–100), and optional per-criterion thresholds. Missing policy defaults to manual review and a threshold of 80.
- Responses expose `BLOCKED`, `REVIEW_REQUIRED`, `AUTO_APPROVED`, `APPROVED`, `REJECTED`, `CHANGES_REQUESTED`, or `SUPERSEDED`, with the complete gate summary for M13. New runs without an AI adapter enter manual review with no scorecard.

## Files changed
- `apps/api/src/app.module.ts`
- `apps/api/src/modules/quality/quality.controller.ts`
- `apps/api/src/modules/quality/quality.module.ts`
- `apps/api/src/modules/quality/quality.postgres.integration.test.ts`
- `apps/api/src/modules/quality/quality.service.ts`
- `apps/api/src/modules/quality/quality.service.test.ts`
- `apps/api/src/modules/quality/quality.types.ts`
- `apps/api/src/modules/quality/quality.validation.ts`
- `packages/ai-providers/src/index.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261109130000_m11_quality_review/migration.sql`
- `packages/database/prisma/migrations/20261110000000_m11_review_hardening/migration.sql`
- `docs/PROJECT_STATE.md`
- `docs/WORK_LOG.md`
- This status file

## Commands and evidence
- `pnpm lint` — **PASS**.
- `pnpm format:check` — **PASS**.
- `DATABASE_URL=postgresql://localhost:55435/reelforge_m11 pnpm typecheck` — **PASS** across all workspaces.
- `pnpm test` — **PASS**, 28 files passed / 9 skipped; 175 tests passed / 77 skipped.
- `pnpm exec vitest run apps/api/src/modules/quality/quality.service.test.ts` — **PASS**, 1 file / 15 tests.
- `DATABASE_URL=<ephemeral PostgreSQL 18.6 URL on localhost:55435> pnpm exec vitest run apps/api/src/modules/quality/quality.postgres.integration.test.ts` — **PASS**, 1 integration test persisted a blocked run and an unconfigured-AI run with SQL `NULL` scorecards, then rejected and approved them respectively.
- `DATABASE_URL=postgresql://localhost:55435/reelforge_m11 NEXT_TELEMETRY_DISABLED=1 pnpm build` — **PASS** across all workspaces.
- `DATABASE_URL=postgresql://localhost:55435/reelforge_m11 pnpm db:validate` — **PASS**.
- `DATABASE_URL=<ephemeral PostgreSQL 18.6 URL on localhost:55435> pnpm db:migrate:deploy` — **PASS**, all 18 migrations applied to fresh disposable PostgreSQL 18.6; the container was stopped and removed. Existing databases on ports 5432, 55432, 55433, and 55434 were not used or stopped.
- `git diff --check` — **PASS**.
- `pnpm install --frozen-lockfile` — **NOT RUN**; no dependency manifest or lockfile changed, and dependencies were already available.
- A supplementary Prisma diff reported pre-existing non-M11 migration/schema drift, left outside this work package.

## Contract/schema authorization
- Core Architect provided written approval for M11-only additive Prisma schema and migration changes.
- Added durable review-run, decision-audit, and regeneration-request tables with tenant-compound references, run supersession, route-override audit, and a maximum of three requests per script lineage and target.
- Added a typed injectable quality-review port under `packages/ai-providers`; no shared contracts package, root tooling, or other module implementation was changed.

## Blockers, risks, and known gaps
- The runtime binds a `NOT_CONFIGURED` provider by default. An evaluation without a real adapter enters manual review with no scorecard; it cannot auto-approve, and no fake adapter or live provider call was added.
- Disclosure flags currently distinguish `AI_GENERATED_ASSET` and `STARTER_LIBRARY_ASSET`. Their product/platform semantics need Core review before M13 treats them as legally sufficient disclosure.
- An `APPROVED` quality status can become stale after rights change; M13 must re-check quality gates at publish time. The regeneration cap relies on script regeneration using M07 `revise()` on the same script ID.
- Codec/audio evidence relies on M10’s validated manifest and output profile; M11 does not re-probe media or duplicate composition.
- The supplementary Prisma diff reports pre-existing non-M11 schema/migration differences; no unrelated migration or schema repair was made.
- The separately tracked Prisma ESM dist-boot follow-up remains open and untouched.

## Next exact action
No M11 product rework is required. The implementation is integrated on `main`; this docs-only closeout records the approval, merge, and residual follow-ups.

## Reviewer decision
- Minu approved PR #20 head `e61af2b92dd553faf96bb96850dcf37864a57a40` in review `5831183493`; Minu merged PR #20 at `42e33c5476ca2f392db199c2db70569c899213d8`.
