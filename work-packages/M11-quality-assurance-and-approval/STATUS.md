# M11 Status - Quality Assurance & Approval

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Completion:** 100% implementation; independent review pending
- **Assigned session/editor:** Module Implementation Agent (Desktop)
- **Branch/worktree:** `work/m11-quality-assurance-and-approval`
- **Last updated:** 2026-11-09
- **Reviewer:** Minu (Core Architect)
- **Approved commit:** none

## Current objective
Provide workspace-scoped quality gates, structured review results, human decisions, and bounded regeneration requests. No publishing or provider-result mutation is implemented.

## Task checklist
- [x] M11-T01: Runtime-validated hard-gate result schema and five review score categories.
- [x] M11-T02: M10 manifest/integrity consumption and aspect, duration, codec, audio, and subtitle checks.
- [x] M11-T03: Script/genre/factuality policy checks and typed AI review with criterion evidence and limitations.
- [x] M11-T04: Pinned asset rights/provenance checks and required disclosure flags.
- [x] M11-T05: Workspace-scoped review queue and audited approve/reject/request-changes decisions.
- [x] M11-T06: Channel-configured score thresholds; failed hard gates always block approval and auto-approval.
- [x] M11-T07: Route-only scene/script/render regeneration requests, limited to three per target across a render retry family.

## API contract
- `POST /workspaces/:workspaceId/quality/runs` — evaluate a successful render job.
- `GET /workspaces/:workspaceId/quality/queue` — oldest 50 `REVIEW_REQUIRED` results.
- `GET /workspaces/:workspaceId/quality/runs/:runId` — retrieve the review result, gate summary, decision audit, and regeneration requests.
- `POST /workspaces/:workspaceId/quality/runs/:runId/decision` — approve, reject, or request changes with a reason; request-changes requires a scene, script, or render route.
- Channel `approvalPolicy` accepts `mode` (`MANUAL` or `AUTO`), `scoreThreshold` (integer 0–100), and optional per-criterion thresholds. Missing policy defaults to manual review and a threshold of 80.
- Responses expose `BLOCKED`, `AI_REVIEW_UNAVAILABLE`, `REVIEW_REQUIRED`, `AUTO_APPROVED`, `APPROVED`, `REJECTED`, or `CHANGES_REQUESTED`, with the complete gate summary for M13.

## Files changed
- `apps/api/src/app.module.ts`
- `apps/api/src/modules/quality/quality.controller.ts`
- `apps/api/src/modules/quality/quality.module.ts`
- `apps/api/src/modules/quality/quality.service.ts`
- `apps/api/src/modules/quality/quality.service.test.ts`
- `apps/api/src/modules/quality/quality.types.ts`
- `apps/api/src/modules/quality/quality.validation.ts`
- `packages/ai-providers/src/index.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261109130000_m11_quality_review/migration.sql`
- `docs/PROJECT_STATE.md`
- `docs/WORK_LOG.md`
- This status file

## Commands and evidence
- `pnpm lint` — **PASS**.
- `pnpm format:check` — **PASS**.
- `DATABASE_URL=postgresql://localhost:55435/reelforge_m11 pnpm typecheck` — **PASS** across all workspaces.
- `pnpm test` — **PASS**, 28 files passed / 8 skipped; 170 tests passed / 76 skipped.
- `pnpm exec vitest run apps/api/src/modules/quality/quality.service.test.ts` — **PASS**, 1 file / 10 tests.
- `DATABASE_URL=postgresql://localhost:55435/reelforge_m11 NEXT_TELEMETRY_DISABLED=1 pnpm build` — **PASS** across all workspaces.
- `DATABASE_URL=postgresql://localhost:55435/reelforge_m11 pnpm db:validate` — **PASS**.
- `DATABASE_URL=<ephemeral PostgreSQL 18.6 URL on localhost:55435> pnpm db:migrate:deploy` — **PASS**, all 17 migrations applied to a fresh disposable database. The first attempt exposed an M11 index-name collision; it was corrected before the successful fresh deployment. The container was removed afterward. Existing databases on ports 5432, 55432, 55433, and 55434 were not used or stopped.
- `git diff --check` — **PASS**.
- `pnpm install --frozen-lockfile` — **NOT RUN**; no dependency manifest or lockfile changed, and dependencies were already available.
- A supplementary Prisma diff found no M11-specific schema changes remaining; the full diff also reported pre-existing non-M11 migration/schema drift, left outside this work package.

## Contract/schema authorization
- Core Architect provided written approval for M11-only additive Prisma schema and migration changes.
- Added durable review-run, decision-audit, and regeneration-request tables with tenant-compound references and a maximum of three requests per render-family target.
- Added a typed injectable quality-review port under `packages/ai-providers`; no shared contracts package, root tooling, or other module implementation was changed.

## Blockers, risks, and known gaps
- The runtime binds a `NOT_CONFIGURED` provider by default. An evaluation without a real adapter is recorded as `AI_REVIEW_UNAVAILABLE`, with no score or approval path; no fake adapter or live provider call was added.
- Disclosure flags currently distinguish `AI_GENERATED_ASSET` and `STARTER_LIBRARY_ASSET`. Their product/platform semantics need Core review before M13 treats them as legally sufficient disclosure.
- Codec/audio evidence relies on M10’s validated manifest and output profile; M11 does not re-probe media or duplicate composition.
- The supplementary Prisma diff reports pre-existing non-M11 schema/migration differences; no unrelated migration or schema repair was made.
- The separately tracked Prisma ESM dist-boot follow-up remains open and untouched.

## Next exact action
Commit and push this branch, open `M11: quality assurance and approval`, request Minu review, and stop. Do not approve or merge.

## Reviewer decision
- Pending.
