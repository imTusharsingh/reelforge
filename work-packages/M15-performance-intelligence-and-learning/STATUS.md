# M15 Status - Performance Intelligence & Learning

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Module Implementation Agent, Desktop
- **Branch/worktree:** `work/m15-performance-intelligence-and-learning`, created from `origin/main` at `c1c95ae851967f44a6ebedc327261106d9ab0cf4`; no worktree created
- **Last updated:** 2026-11-10
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** none

## Current objective
Translate verified historical metrics into explainable recommendations and controlled experiments.

## Task checklist
- [x] M15-T01: T01 Define KPI calculations and comparison windows with minimum sample rules.
- [x] M15-T02: T02 Build descriptive performance summaries by topic, hook, duration, character, series, and publish timing where data supports it.
- [x] M15-T03: T03 Generate evidence-linked AI insight reports using metric snapshots as source context.
- [x] M15-T04: T04 Generate ranked next-content recommendations with confidence/limitations.
- [x] M15-T05: T05 Store experiments and hypotheses; avoid changing multiple dimensions without a documented design.
- [x] M15-T06: T06 Require approval before applying any recommendation to channel configuration.
- [x] M15-T07: T07 Feed approved, versioned strategy changes into the next planning cycle.

## Files changed
- `apps/api/src/modules/performance-intelligence/performance-intelligence.service.ts` (new): KPI definitions/evaluation, window comparison, minimum-sample gating, dimension summaries, insight report persistence, recommendations, experiments, and versioned strategy-change export.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.controller.ts` (new): workspace-scoped authenticated routes for KPIs, reports, recommendations, experiments, and strategy changes.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.module.ts` (new): wires identity/workspace/analytics/publishing dependencies and the fail-closed insight LLM provider.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.ports.ts` (new): M08-shaped `InsightReportLlmPort` using `CapabilityMetadata`/`ProviderProvenance`; `NotConfiguredInsightReportLlm` fails closed.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.tokens.ts` (new): `INSIGHT_REPORT_LLM` token and port re-exports.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.validation.ts` (new): strict runtime request parsers for all M15 routes.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.service.test.ts` (new): fixture-only unit coverage for KPI rules, insufficient data, AI configured/unconfigured/failed, recommendations, experiments, approvals, and strategy changes.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.postgres.integration.test.ts` (new): PostgreSQL persistence and cross-tenant denial coverage.
- `apps/api/src/app.module.ts`: registered `PerformanceIntelligenceModule`.
- `apps/api/src/modules/analytics/analytics.service.ts`: additive read-only `listLatestSnapshots` export for M15; no collection behavior changed.
- `apps/api/src/modules/analytics/analytics.service.test.ts`: coverage for the snapshot read export and tenant denial.
- `apps/api/src/modules/publishing/publishing.service.ts`: additive read-only `listPublishedPostContexts` export joining topic/hook/series/characters/duration; existing publish behavior unchanged.
- `apps/api/src/modules/publishing/publishing.service.test.ts`: coverage for the post-context read export.
- `packages/contracts/src/performance-intelligence.ts` (new): KPI/dimension/report/recommendation/experiment/strategy-change contracts and request schemas.
- `packages/contracts/src/analytics.ts`: additive `LatestMetricSnapshotSchema` and `LatestMetricSnapshotQuerySchema`.
- `packages/contracts/src/publishing.ts`: additive `PublishedPostContextSchema`.
- `packages/contracts/src/index.ts`: exported the M15 contracts.
- `packages/database/prisma/schema.prisma`: additive M15 enums/models (`PerformanceInsightReport`, `PerformanceRecommendation`, `PerformanceExperiment`, `PerformanceStrategyChange`) and back-relations.
- `packages/database/prisma/migrations/20261113010000_m15_performance_intelligence/migration.sql` (new): additive migration ordered strictly after `20261112010000_m14_metric_store`.

## Commands and evidence
Executed with Node `24.22.2` and pnpm `12.16.1` via `export PATH="$HOME/.nvm/versions/node/v24.22.2/bin:$PATH"`. Database commands used a fresh disposable PostgreSQL 18.6 container mapped only to `127.0.0.1:55437`.

- `pnpm install --frozen-lockfile` **passed** (12 workspace projects; lockfile current).
- `pnpm lint` **passed**.
- `pnpm format:check` **passed**.
- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55437/reelforge_m15?schema=public pnpm typecheck` **passed** across all workspaces, including Prisma Client generation.
- `DATABASE_URL=... pnpm test` **passed**: 51 test files passed / 1 skipped; 337 tests passed / 5 skipped. The 5 skips are the pre-existing FFmpeg/ffprobe cases.
- Focused M15 suites **passed**: 2 files / 15 tests (fixture unit + PostgreSQL integration).
- Focused M13/M14 read-export coverage **passed**: 4 files / 36 tests.
- `DATABASE_URL=... pnpm build` **passed**.
- `DATABASE_URL=... pnpm db:validate` **passed** (schema valid, no warnings after replacing composite `SetNull` links with `Restrict`).
- `DATABASE_URL=... pnpm db:migrate:deploy` **passed** on the fresh disposable database; all migrations, including `20261113010000_m15_performance_intelligence`, applied from scratch.
- `git diff --check` **passed**.

## Contract/schema proposals
The M15 assignment explicitly authorized additive contracts, additive Prisma schema, and a migration timestamp strictly later than `20261112010000`; those changes are limited to the files listed above.

- Additive contracts: M15 types plus `LatestMetricSnapshot*` (M14 read export) and `PublishedPostContext` (M13 read export).
- Additive schema/migration: four new M15 models and four enums; no existing column or table altered.
- Minimal additive read-only service methods: `AnalyticsService.listLatestSnapshots`, `PublishingService.listPublishedPostContexts`.
- Root module registration: `PerformanceIntelligenceModule` added to `apps/api/src/app.module.ts`.

## Blockers / risks / unknowns
- AI narratives are optional and fail closed. The default provider is `NotConfiguredInsightReportLlm`; when unconfigured, reports still contain deterministic KPI/dimension summaries with an explicit limitation and `aiStatus = NOT_CONFIGURED`. No live AI/social call occurs in startup, health checks, tests, migrations, seeds, or CI.
- Provider cost provenance (`providerId`, model/prompt version, cost, currency) is stored on the insight report row. No separate budget reservation or `providerRequest` ledger row is written by M15; a full M08 budget/cost-ledger integration is a possible follow-up if the reviewer requires it.
- M15 is editor-triggered. There is no scheduler or worker handler.
- Instagram insights are not implemented and remain fail-closed through the M14 YouTube-only snapshot source.
- KPI definitions and minimum-sample rules are code constants, not persisted configuration.
- Recommendations never auto-apply to M05/M06. Only an explicit, approved, versioned strategy-change record is exported; channel configuration is not mutated.
- `listLatestSnapshots` returns the latest available snapshot per metric/day/entity; KPI evaluation falls back to VIDEO snapshots when CHANNEL snapshots are absent.
- No UI was added; this work package owns backend behavior only.
- The pre-existing Prisma ESM follow-up and production OAuth/connector configuration remain outside M15.

## Next exact action
Commit the branch, push it, open the M15 PR against `main`, request review from `minu-the-reviewer`, and stop without merging.

## Handoff notes
All M15 tasks T01–T07 are implemented and covered by fixture and PostgreSQL tests. The module is ready for reviewer verification of acceptance criteria, tenant scoping, fail-closed behavior, and additive contract/schema compatibility.

## Reviewer decision
- Pending.
