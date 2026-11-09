# M14 Status - Analytics Collection & Metric Store

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Completion:** 100% of assigned implementation (estimate only; not approval).
- **Assigned session/editor:** Module Implementation Agent, Desktop
- **Branch/worktree:** `work/m14-analytics-collection-and-metric-store` / `../reelforge-m14`
- **Base:** `75eee789921948a1d19427c4b2994a88a8766bbe` (M13 on `origin/main`)
- **Phase 1 commit:** `dc092c3` (pushed)
- **Phase 2 commit:** pending commit for this handoff
- **Last updated:** 2026-11-10
- **Reviewer:** Minu (Core Architect)
- **Approved commit:** none

## Current objective
Collect and normalize YouTube metrics with provenance, reporting period, collection timestamp, completeness, and retry state; export published posts from M13; keep Instagram fail-closed; never fabricate values or overwrite prior valid snapshots on API failure. No live Google or Meta calls were made.

## Task checklist
- [x] M14-T01: Seeded a YouTube metric catalog with account eligibility, permission, granularity, availability notes, official source URLs, and verification date.
- [x] M14-T02: Editor-triggered YouTube collection runs through M12's authenticated Analytics client and the official `reports.query` endpoint. Collection is synchronous on `POST /workspaces/:workspaceId/analytics/collection-jobs/:jobId/run`; no scheduler/worker was added.
- [x] M14-T03: Instagram collection remains explicitly unsupported and fail-closed; the M12 connector stays `NOT_CONFIGURED`, and no Instagram metrics are claimed.
- [x] M14-T04: Added additive catalog, job, run, and immutable snapshot persistence with reporting windows, collection time, source API, completeness/provenance fields, and supersession links.
- [x] M14-T05: Aggregates keep missing values null/unavailable, distinguish partial windows from zero, select the newest snapshot per metric/day, and preserve prior valid snapshots when a later report is missing or the API fails.
- [x] M14-T06: Added tenant-scoped channel/video aggregate queries requiring explicit date windows.
- [x] M14-T07: Added bounded exponential backoff/Retry-After policy. Retry state is persisted (`RETRY_WAIT`, `retryCount`, `nextAttemptAt`, `lastErrorCode`) and an editor can rerun the job after the retry window; permanent failures become `FAILED_FINAL`.

## Official YouTube Analytics references
Reviewed 2026-11-10; API endpoint version v2 (`GET /v2/reports`).

- [Reports query](https://developers.google.com/youtube/analytics/reference/reports/query): requests require a date range, channel identity, metrics, and authorization. The current page states requests require `https://www.googleapis.com/auth/youtube.readonly`.
- [Channel reports](https://developers.google.com/youtube/analytics/channel_reports): verified channel and per-video report shapes and available metric/dimension combinations.
- [Metrics](https://developers.google.com/youtube/analytics/metrics): verified metric definitions; the catalog uses core view, engagement, watch-time, and subscriber metrics only. Monetary metrics are excluded.
- [Dimensions](https://developers.google.com/youtube/analytics/dimensions): verified `day` and `video` dimensions.

M12 already requests `youtube.readonly`, so no new OAuth scope was added. The M14 catalog and migration seed now record `youtube.readonly` instead of `yt-analytics.readonly`.

## Files changed (Phase 2)
- `apps/api/src/app.module.ts` (additive `AnalyticsModule` registration)
- `apps/api/src/modules/analytics/analytics.catalog.ts`
- `apps/api/src/modules/analytics/analytics.collection.test.ts` (new)
- `apps/api/src/modules/analytics/analytics.controller.ts`
- `apps/api/src/modules/analytics/analytics.module.ts`
- `apps/api/src/modules/analytics/analytics.ports.ts`
- `apps/api/src/modules/analytics/analytics.postgres.integration.test.ts`
- `apps/api/src/modules/analytics/analytics.publishing-source.ts` (new, M13 adapter)
- `apps/api/src/modules/analytics/analytics.service.ts`
- `apps/api/src/modules/analytics/analytics.tokens.ts`
- `apps/api/src/modules/analytics/analytics.validation.ts`
- `apps/api/src/modules/analytics/analytics.youtube-client.ts` (new, M12 adapter)
- `apps/api/src/modules/social-accounts/social-accounts.service.ts` (additive authenticated Analytics operation)
- `apps/api/src/modules/social-accounts/social-accounts.service.test.ts`
- `packages/contracts/src/analytics.ts` (removed duplicate published-post contract; optional report `kind`)
- `packages/database/prisma/migrations/20261112010000_m14_metric_store/migration.sql` (catalog scopes)
- `packages/social-providers/src/types.ts` (additive Analytics request/connector types)
- `packages/social-providers/src/youtube.connector.ts` (additive `queryAnalytics`)
- `packages/social-providers/src/youtube.connector.test.ts`
- This status file and `docs/WORK_LOG.md`

Phase 1 files (catalog contracts, Prisma models, migration, retry policy) were committed in `dc092c3` and are unchanged except the scope seed.

## Commands and evidence
Node 24.22.2 and pnpm 12.16.1 were used. Database work used the disposable PostgreSQL container `reelforge-m14-db` on `127.0.0.1:55436` only.

- `pnpm install --frozen-lockfile` — **PASS**, lockfile up to date.
- `pnpm lint` — **PASS** (one missing test return type found and fixed before the passing rerun).
- `pnpm format:check` — **PASS**, all files match Prettier.
- `DATABASE_URL=<disposable URL> pnpm typecheck` — **PASS** across all workspaces.
- `DATABASE_URL=<disposable URL> pnpm test` — **PASS**, 49 files passed / 1 skipped; 316 tests passed / 5 skipped. The 5 skips are the existing FFmpeg/ffprobe-dependent suites.
- `DATABASE_URL=<disposable URL> pnpm build` — **PASS** across all workspaces. A first attempt without `DATABASE_URL` failed because `prisma.config.ts` requires the variable; the rerun with the disposable URL passed.
- `DATABASE_URL=<disposable URL> pnpm db:validate` — **PASS**, Prisma schema valid.
- `DATABASE_URL=<fresh disposable URL> pnpm db:migrate:deploy` — **PASS**, all 21 migrations including `20261112010000_m14_metric_store` applied to a freshly created database.
- `DATABASE_URL=<disposable URL> pnpm exec vitest run apps/api/src/modules/analytics packages/social-providers/src/youtube.connector.test.ts apps/api/src/modules/social-accounts/social-accounts.service.test.ts` — **PASS**, 6 files / 43 tests.
- No API server was started; no Google or Meta calls were made.

## Acceptance evidence
- Every persisted metric carries `sourceApi`, `periodStart`/`periodEnd`, `collectedAt`, completeness, availability, and `remoteEntityId` where applicable.
- Missing report rows or metric columns are stored as `UNAVAILABLE` with a reason, never as zero.
- A failed provider call writes no snapshots and leaves prior snapshots unchanged; the integration test asserts the prior run's rows are byte-for-byte unchanged after failure.
- Collection and aggregate paths scope by `workspaceId`; cross-tenant aggregate reads and cross-tenant job references are denied (integration test).
- `VIEWER` is rejected before job lookup or provider access (unit test).
- No recommendations or content-setting changes were made.

## Contract/schema proposals and blockers
- Additive M14 contracts and Prisma models/migration were authorized by Minu's written assignment. No applied migration was rewritten; the M14 migration remains the latest (`20261112010000`, strictly later than M13 `20261110120000`).
- M12 change is limited to an additive authenticated `queryAnalytics` operation using the existing token/scope boundary. No OAuth scope change and no change to upload/refresh/health behavior.
- No M13 FK was added; the export is consumed read-only through `PublishingService.listPublishedRecords`, preserving M13 deletion semantics.
- `AnalyticsModule` was registered additively in the Core-owned API root module as assigned.
- No scheduler/worker collection was added; collection is editor-triggered as scoped. A future scheduler would need its own assignment.
- Instagram collection remains unimplemented and fail-closed.

## Next exact action
Minu reviews the diff, acceptance evidence, and the M12 additive Analytics operation. If approved, merge the M14 PR; do not self-approve or merge from this session.

## Reviewer decision
- Pending; no approval, integration, or review request is claimed by this session.
