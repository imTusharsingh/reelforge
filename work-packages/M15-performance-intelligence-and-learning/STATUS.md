# M15 Status - Performance Intelligence & Learning

- **State:** IMPLEMENTED_PENDING_REVIEW (review round 1 fixes applied)
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

## Dimension methodology
- Dimension comparisons use **views per video-day**: available view snapshots in the report window divided by the distinct in-window days each video has view data. This normalizes for different publish ages instead of comparing raw lifetime views.
- Videos published before the report window are included when they still have in-window view data; videos with no available in-window snapshot are excluded.
- A recommendation is only produced from a dimension with at least two `OK` buckets. Candidates are ranked by lift against that dimension's baseline (all joined videos), and both the baseline and lift are stored in the recommendation rationale.
- Recommendations always carry limitations: the association is correlational, the candidate and baseline sample sizes/window are recorded, and unjoined `UNKNOWN` videos are called out. Confidence is capped at `LOW` when either the candidate bucket or the baseline is at the minimum sample.
- KPI current/previous windows now use one granularity for both sides. When `CHANNEL` snapshots are only available in one window, both sides fall back to `VIDEO` granularity and the report records that limitation.

## Review fixes (round 1)
- **B1:** Recommendations now require at least two `OK` buckets in a dimension, rank by lift against the dimension baseline, persist lift/baseline in `rationale`, and always attach correlational/sample/window/unjoined limitations. Confidence is capped at `LOW` at minimum sample. Unit coverage includes single-bucket → no recommendation and non-empty limitations.
- **B2:** Dimension performance is normalized to views per video-day, and videos published before the window are included when they have in-window metrics. Unit coverage uses videos of different publish ages (including one before the window).
- **B3:** Added a unique key on `(workspaceId, recommendationId)` for strategy changes. Export returns the existing change on re-export, allocates versions in a transaction, and retries once/maps unique conflicts to `409`. Recommendation approval is now an `updateMany` compare-and-swap on `PROPOSED` and returns `409` when the count is zero. Unit and PostgreSQL concurrency coverage added.
- **B4:** Experiment completion now requires a non-null exposure from the request or existing row and only transitions `DRAFT`/`RUNNING` to `COMPLETED` via a status compare-and-swap; otherwise it returns `409`. Unit and PostgreSQL coverage added.
- **Non-blocking addressed:** KPI comparison uses one granularity for both windows; `aiStatus`, `dimension`, and `confidence` (plus experiment dimensions) now use Prisma enums; repeated recommendation generation returns existing rows instead of duplicating them.
- **Non-blocking deferred:** The AI port still carries `ProviderProvenance` without writing an M08 cost-ledger entry (acceptable while fail-closed/unconfigured; must use the M08 ledger envelope before a real adapter is bound). `videoPoints` still pages workspace-wide and filters in memory (v1; add a channel/date-scoped read later). `REJECTED`/`RUNNING`/`EXPORTED` transitions remain intentionally unimplemented.

## Files changed
- `apps/api/src/modules/performance-intelligence/performance-intelligence.service.ts` (new): KPI definitions/evaluation, window comparison, minimum-sample gating, dimension summaries, insight report persistence, recommendations, experiments, and versioned strategy-change export.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.controller.ts` (new): workspace-scoped authenticated routes for KPIs, reports, recommendations, experiments, and strategy changes.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.module.ts` (new): wires identity/workspace/analytics/publishing dependencies and the fail-closed insight LLM provider.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.ports.ts` (new): M08-shaped `InsightReportLlmPort` using `CapabilityMetadata`/`ProviderProvenance`; `NotConfiguredInsightReportLlm` fails closed.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.tokens.ts` (new): `INSIGHT_REPORT_LLM` token and port re-exports.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.validation.ts` (new): strict runtime request parsers for all M15 routes.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.service.test.ts` (new): fixture-only unit coverage for KPI rules, exposure normalization, insufficient data, AI configured/unconfigured/failed, recommendation lift/limitations/single-bucket behavior, experiment completion guards, approval compare-and-swap, and idempotent strategy-change export.
- `apps/api/src/modules/performance-intelligence/performance-intelligence.postgres.integration.test.ts` (new): PostgreSQL persistence, cross-tenant denial, concurrent approval, re-export idempotency, and experiment outcome guard coverage.
- `apps/api/src/app.module.ts`: registered `PerformanceIntelligenceModule`.
- `apps/api/src/modules/analytics/analytics.service.ts`: additive read-only `listLatestSnapshots` export for M15; no collection behavior changed.
- `apps/api/src/modules/analytics/analytics.service.test.ts`: coverage for the snapshot read export and tenant denial.
- `apps/api/src/modules/publishing/publishing.service.ts`: additive read-only `listPublishedPostContexts` export joining topic/hook/series/characters/duration; existing publish behavior unchanged.
- `apps/api/src/modules/publishing/publishing.service.test.ts`: coverage for the post-context read export.
- `packages/contracts/src/performance-intelligence.ts` (new): KPI/dimension/report/recommendation/experiment/strategy-change contracts and request schemas.
- `packages/contracts/src/analytics.ts`: additive `LatestMetricSnapshotSchema` and `LatestMetricSnapshotQuerySchema`.
- `packages/contracts/src/publishing.ts`: additive `PublishedPostContextSchema`.
- `packages/contracts/src/index.ts`: exported the M15 contracts.
- `packages/database/prisma/schema.prisma`: additive M15 enums/models (`PerformanceInsightReport`, `PerformanceRecommendation`, `PerformanceExperiment`, `PerformanceStrategyChange`) and back-relations, including enums for `aiStatus`, `dimension`, `confidence`, and experiment dimensions plus the `(workspaceId, recommendationId)` strategy-change unique key.
- `packages/database/prisma/migrations/20261113010000_m15_performance_intelligence/migration.sql` (new): additive migration ordered strictly after `20261112010000_m14_metric_store`.

## Commands and evidence
Executed with Node `24.22.2` and pnpm `12.16.1` via `export PATH="$HOME/.nvm/versions/node/v24.22.2/bin:$PATH"`. Database commands used a fresh disposable PostgreSQL 18.6 container mapped only to `127.0.0.1:55437`.

- `pnpm install --frozen-lockfile` **passed** (12 workspace projects; lockfile current).
- `pnpm lint` **passed**.
- `pnpm format:check` **passed**.
- `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55437/reelforge_m15?schema=public pnpm typecheck` **passed** across all workspaces, including Prisma Client generation.
- `DATABASE_URL=... pnpm test` **passed**: 51 test files passed / 1 skipped; 343 tests passed / 5 skipped. The 5 skips are the pre-existing FFmpeg/ffprobe cases.
- Focused M15 suites **passed**: 2 files / 21 tests (17 fixture unit + 4 PostgreSQL integration).
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
- Provider cost provenance (`providerId`, model/prompt version, cost, currency) is stored on the insight report row. No separate budget reservation or `providerRequest` ledger row is written by M15. The default remains fail-closed/unconfigured; before any real adapter is bound, it must go through the M08 provider/cost-ledger envelope.
- M15 is editor-triggered. There is no scheduler or worker handler.
- `videoPoints` pages every published record in the workspace and filters in memory. This is acceptable for v1 but should be replaced with a channel/date-scoped read as volume grows.
- `REJECTED` (recommendation and experiment), `RUNNING`, and `EXPORTED` transitions are intentionally not implemented in this package.
- Instagram insights are not implemented and remain fail-closed through the M14 YouTube-only snapshot source.
- KPI definitions and minimum-sample rules are code constants, not persisted configuration.
- Recommendations never auto-apply to M05/M06. Only an explicit, approved, versioned strategy-change record is exported; channel configuration is not mutated.
- `listLatestSnapshots` returns the latest available snapshot per metric/day/entity. KPI evaluation uses CHANNEL granularity only when both windows have it; otherwise both windows use VIDEO granularity and the report records the fallback limitation.
- No UI was added; this work package owns backend behavior only.
- The pre-existing Prisma ESM follow-up and production OAuth/connector configuration remain outside M15.

## Next exact action
Commit the review-fix changes, push `work/m15-performance-intelligence-and-learning`, request re-review from `minu-the-reviewer` on PR #27, and stop without merging.

## Handoff notes
All M15 tasks T01–T07 are implemented and covered by fixture and PostgreSQL tests. Review round 1 blocking issues B1–B4 are addressed with new unit and PostgreSQL coverage; the remaining non-blocking follow-ups are listed above. The module is ready for reviewer verification of acceptance criteria, tenant scoping, fail-closed behavior, and additive contract/schema compatibility.

## Reviewer decision
- Round 1: REQUEST_CHANGES at `f695bc6` (B1–B4).
- Round 2: Pending re-review.
