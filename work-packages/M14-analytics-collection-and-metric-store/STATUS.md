# M14 Status - Analytics Collection & Metric Store

- **State:** Phase 1 done, waiting on M13
- **Phase 1 completion:** 100%; M14 overall remains in progress.
- **Assigned session/editor:** Module Implementation Agent, Desktop
- **Branch/worktree:** `work/m14-analytics-collection-and-metric-store` / `../reelforge-m14`
- **Base:** `a83132b9064a04e3b92266aa9ec4748551299062` (M12)
- **Implementation commit:** `9adfa421ffd5d21c5b6d50a4aca71c33d8191e65` (pushed to `origin`)
- **Last updated:** 2026-11-10
- **Reviewer:** Minu (Core Architect)
- **Approved commit:** none

## Current objective
Define and persist provenance-bearing analytics contracts while failing closed where M12/M13 provider capabilities are not yet available. No live platform calls were made.

## Task checklist
- [x] M14-T01: Seeded a YouTube metric catalog with account eligibility, permission, granularity, availability notes, official source URLs, and verification date.
- [ ] M14-T02: Added an editor-only collection-job request and fail-closed YouTube client port. Scheduled execution and the authenticated Analytics API adapter remain blocked on M12's missing Analytics request interface and scope decision.
- [x] M14-T03: Instagram collection is explicitly unsupported; the M12 connector remains `NOT_CONFIGURED`, and no Instagram metrics are claimed.
- [x] M14-T04: Added additive catalog, job, run, and immutable snapshot persistence with reporting windows, collection time, source API, and completeness/provenance fields.
- [x] M14-T05: Aggregates keep missing values null/unavailable, distinguish partial windows from zero, and select the newest snapshot per metric/day; revisions append rather than update.
- [x] M14-T06: Added tenant-scoped channel/video aggregate queries requiring explicit date windows.
- [ ] M14-T07: Added bounded exponential backoff/Retry-After policy and retry metadata; wiring retries into a scheduled worker remains blocked with T02.

## Official YouTube Analytics references
Reviewed 2026-11-10; API endpoint version v2 (`GET /v2/reports`).

- [Reports query](https://developers.google.com/youtube/analytics/reference/reports/query): requests require date range, channel/content-owner identity, metrics, and authorization. The current page's notice says requests now require `youtube.readonly`, while its scope table still lists `yt-analytics.readonly`.
- [Channel reports](https://developers.google.com/youtube/analytics/channel_reports): verified channel video reports and available metric/dimension combinations.
- [Metrics](https://developers.google.com/youtube/analytics/metrics): verified metric definitions; the catalog uses core view, engagement, watch-time, and subscriber metrics only. Monetary metrics are excluded.
- [Dimensions](https://developers.google.com/youtube/analytics/dimensions): verified date/video dimensions.

## Files changed
- `apps/api/src/modules/analytics/analytics.catalog.ts`
- `apps/api/src/modules/analytics/analytics.controller.ts`
- `apps/api/src/modules/analytics/analytics.module.ts`
- `apps/api/src/modules/analytics/analytics.ports.ts`
- `apps/api/src/modules/analytics/analytics.retry.ts`
- `apps/api/src/modules/analytics/analytics.retry.test.ts`
- `apps/api/src/modules/analytics/analytics.service.ts`
- `apps/api/src/modules/analytics/analytics.service.test.ts`
- `apps/api/src/modules/analytics/analytics.tokens.ts`
- `apps/api/src/modules/analytics/analytics.validation.ts`
- `apps/api/src/modules/analytics/analytics.postgres.integration.test.ts`
- `packages/contracts/src/analytics.ts`
- `packages/contracts/src/index.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261112010000_m14_metric_store/migration.sql`
- This status file and `docs/WORK_LOG.md`

`apps/api/src/app.module.ts` was not changed because root route registration is Core-owned. The new API module is not active until Minu approves and adds that registration.

## Commands and evidence
Node 24.22.2 and pnpm 12.16.1 were used. All database work used a fresh disposable PostgreSQL 18.6 database on host port 55436.

- `pnpm install --frozen-lockfile` — initial attempt failed with `ERR_PNPM_UNSUPPORTED_ENGINE` under Node 24.16.0; rerun with pinned Node 24.22.2 **PASS**.
- `pnpm lint` — **PASS**.
- `pnpm format:check` — **PASS**.
- `DATABASE_URL=<disposable PostgreSQL URL on 127.0.0.1:55436> pnpm typecheck` — **PASS** across workspaces.
- `DATABASE_URL=<disposable PostgreSQL URL on 127.0.0.1:55436> pnpm test` — **PASS**, 44 files passed / 1 skipped; 283 tests passed / 5 skipped.
- `DATABASE_URL=<disposable PostgreSQL URL on 127.0.0.1:55436> pnpm build` — **PASS** across workspaces.
- `DATABASE_URL=<disposable PostgreSQL URL on 127.0.0.1:55436> pnpm db:validate` — **PASS**.
- `DATABASE_URL=<fresh disposable PostgreSQL URL on 127.0.0.1:55436> pnpm db:migrate:deploy` — **PASS**, all 20 migrations applied to a fresh database.
- `pnpm exec vitest run apps/api/src/modules/analytics` — **PASS**, 3 files / 10 tests, including append-only revision preservation.
- `DATABASE_URL=<disposable PostgreSQL URL on 127.0.0.1:55436> pnpm exec vitest run apps/api/src/modules/analytics/analytics.postgres.integration.test.ts` — **PASS**, 1 file / 3 tests, including cross-workspace denial, immutable-snapshot enforcement, and revisions.
- No API server was started; no Google or Meta calls were made.

## Contract/schema proposals and blockers
- Additive M14 contracts and Prisma models/migration were authorized by Minu's written assignment. No applied migration was rewritten and no M00-M13 model was changed.
- M13 is not on `origin/main` (latest fetched tip: `1a3436d`, M12 closeout). `PublishedPostSource` is typed and no M13 FK is present. Wire it to M13's exported contract only after M13 merges.
- M12's `authenticatedClient` currently supports health/refresh only, not Analytics API requests. M12 records `youtube.readonly` and `youtube.upload`, not the required `yt-analytics.readonly` permission used here. Minu must decide whether M12 should request that scope or whether M14 should use the current `reports.query` requirement (`youtube.readonly`), and approve the authenticated query interface. M14 did not change M12.
- Migration timestamp `20261112010000` is later than current main; recheck it against all M13 migrations after rebase and regenerate if necessary.
- `AnalyticsModule` is not registered in the Core-owned API root module. No runtime metric collection is claimable until route registration, M12 client/scope, and the M13 source/worker integration are resolved.

## Next exact action
Wait for M13 to merge. Then fetch and rebase this branch onto post-M13 `origin/main`, retain both append-only work-log entries, recheck/regenerate the M14 migration timestamp, wire `PublishedPostSource` and M12's approved Analytics client, obtain Core approval for API root registration, finish scheduled execution/retry wiring, and rerun the full verification list before requesting review. No PR was created because M13 is not merged.

## Reviewer decision
- Pending; no approval, integration, or review request is claimed.
