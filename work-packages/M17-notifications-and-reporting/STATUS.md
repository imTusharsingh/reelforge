# M17 Status - Notifications & Reporting

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Module Implementation Agent, Desktop TRACXN-LP-784 (local, no cloud agent)
- **Branch/worktree:** `work/m17-notifications-and-reporting` in worktree `/home/tracxn-lp-784/Desktop/project/reelforge-m17`, from `origin/main` `6e4f2965f3b3c6d4097eae2153bf9874b2d99a63`
- **Last updated:** 2026-11-10
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** none
- **Completion estimate:** ~90% (estimate only, not approval). Remaining: review, and a real email adapter once a sender is chosen.

## Current objective
Deliver useful event-based notifications and scheduled channel reports.

## Task checklist
- [x] M17-T01: Event catalog (`notifications.catalog.ts`, typed constant) and per-member, per-event, per-channel preferences (in-app/email booleans) with catalog defaults when no row exists.
- [x] M17-T02: In-app notifications persisted per workspace and recipient member, with `readAt`, list (unread filter), mark read, mark all read, and dedupe on unique `(workspaceId, recipientMemberId, dedupeKey)`.
- [x] M17-T03: `NotificationEmailPort` with the default `NotConfiguredNotificationEmail`. No live adapter (sender still a pending decision). Due deliveries are recorded `SKIPPED_NOT_CONFIGURED`; nothing ever reports a fake `SENT`. Tests use a fake port.
- [x] M17-T04: Daily/weekly channel reports from persisted data only, in the channel's IANA timezone (DST-safe), idempotent per `(channelId, periodType, periodStart)`, stored as structured JSON with explicit `missingData`. No LLM.
- [x] M17-T05: Relative deep links (route shapes below).
- [x] M17-T06: Delivery retry with exponential backoff and persisted attempts, dedupe, preferences respected, and paused/archived channels suppressed from scheduled reports.

## Files changed
- New module `apps/api/src/modules/notifications/`: `notifications.catalog.ts`, `notifications.links.ts`, `notifications.ports.ts`, `notifications.sources.ts`, `notifications.validation.ts`, `notifications.service.ts`, `reports.periods.ts`, `reports.service.ts`, `notifications.controller.ts`, `notifications.module.ts`; tests `notifications.catalog.test.ts`, `reports.periods.test.ts`, `reports.service.test.ts`, `notifications.postgres.integration.test.ts`.
- Worker: `apps/worker/src/handlers/notifications/{factory.ts,handler.ts,notifications.test.ts}`; `apps/worker/src/main.ts` starts/stops it next to the composition poller and the M16 handler; `apps/worker/tsconfig.json` path for `@reelforge/api/notifications-service`.
- Entry point `apps/api/src/notifications-service.ts` and `apps/api/package.json` `exports["./notifications-service"]` (same pattern as M16's `orchestration-service`).
- Shared files (Core-approved, minimal): `packages/database/prisma/schema.prisma` (M17 models + back-relation fields on `Workspace`, `WorkspaceMembership`, `Channel`), migration `20261116010000_m17_notifications_and_reporting`, enum exports in `packages/database/src/index.ts`, `NotificationsModule` in `apps/api/src/app.module.ts`.
- Additive, read-only `@internal` methods on other modules' services (no behavior change, documented here as the approval requires):
  - `OrchestrationService.listEventsAfter` (cross-workspace run-event read for intake) and `countRunOutcomes` (per-channel completed-run counts for reports).
  - `QualityService.listReviewRequestsAfter` and `listDecisionsAfter`.
  - `PerformanceIntelligenceService.listInsightReportsAfter` and `listChannelInsightsBetween` (period-bounded `[from, to)` channel reports/recommendations with exact totals, for M17 reports; added for review B3).
  - `PublishingService.listReconciliationRequiredAfter`.
  - `ChannelService.listReportChannels` (cross-workspace when no workspaceId; never exposed by a controller).
  - `WorkspaceService.listMembers` (recipient resolution).
- Approved shared edit (review 5839809149 B2): intake keyset indexes on other modules' tables, as `@@index` in `schema.prisma` and `CREATE INDEX` in the (unmerged) M17 migration: `workflow_events(occurred_at, id)`, `outbox_events(occurred_at, id)`, `quality_review_runs(created_at, id)`, `quality_decisions(created_at, id)`, `performance_insight_reports(created_at, id)`, `publishing_destinations(status, updated_at, id)`. Index-only; no column or behavior change in those modules.
- Docs: this file and `docs/WORK_LOG.md`. `PROJECT_STATE.md` and `ci.yml` are untouched. No new dependencies; lockfile unchanged.

## Design
- **Event catalog (T01).** `REVIEW_NEEDED`, `REVIEW_APPROVED`, `REVIEW_REJECTED` (M11); `PUBLISH_SUCCEEDED`, `PUBLISH_FAILED`, `PUBLISH_RECONCILIATION_REQUIRED` (M13); `RUN_FAILED`, `RUN_RECONCILIATION_REQUIRED`, `RUN_WAITING_APPROVAL`, `RUN_SUCCEEDED` (M16); `ANALYTICS_REPORT_READY` (M15 insight report built on M14 metrics); `CHANNEL_REPORT_READY` (M17). Each entry has an audience (`ALL_MEMBERS` or `EDITORS` for action-required types), a severity, a link kind, default preferences, and deterministic title/body templates. Email defaults to on only for failures, reconciliation, and review-needed.
- **Intake.** `NotificationIntakeSources` reads `outbox_events` (`PostPublished`, `PublishFailed`) directly (approved) and everything else through the `@internal` service reads above. Each source has a persisted cursor in `notification_intake_cursors` (one row per source). A page is read up to `now - 30 s` (settle window for late commits), the cursor moves by compare-and-set in the same transaction as `createMany(skipDuplicates)` into `notification_events`, which is unique on `(workspaceId, sourceKey)`. Every reader is a strict keyset: `ts > after.at OR (ts = after.at AND id > after.id)`, ordered by `(ts, id)`, so any number of rows sharing one timestamp is paged through across batches and ticks (tested with `batchSize + 1` rows on one timestamp); there is no stall branch. A source without a cursor starts at `now - settle` (`(until, ffffffff-…)`), so turning M17 on does not replay history; `intakeBackfill: true` starts from the beginning instead (tests use it for back-dated fixtures). Redelivery and a full cursor reset with backfill are no-ops through the unique key (tested). All source timestamps are written by Prisma at millisecond precision, matching the JS `Date` in the cursor (no raw SQL writes to those tables). R1: the 30 s settle window assumes source transactions commit within ~5 s of their timestamp and API/worker clocks are within ~30 s (documented on `intakeSettleMs`). Source keys: `m13:outbox:<eventId>`, `m13:reconciliation:<destinationId>:<retryCount>`, `m16:event:<eventId>` (`m16:run-succeeded:<runId>` for success), `m11:review-needed:<reviewRunId>`, `m11:decision:<decisionId>`, `m15:insight-report:<reportId>`, `m17:channel-report:<reportId>`. Correlation ids are carried from the outbox/M16 events.
- **Fan-out.** A PENDING event is fanned out to workspace members filtered by audience, applying stored preferences or catalog defaults. The DONE marker, in-app inserts, and email-delivery inserts commit in one transaction with `skipDuplicates` on the per-recipient dedupe key, so a crash or re-run is a no-op (tested by forcing every event back to PENDING).
- **Email (T03/T06).** `notification_deliveries` rows (`PENDING → SENDING → SENT | RETRY_WAIT | FAILED`, or `SKIPPED_NOT_CONFIGURED`). Attempts, `nextAttemptAt`, error code/message persist. Backoff is 60 s × 2^(n-1), capped at 1 h; max 5 attempts. A send whose lease (2 min) expires is recorded `FAILED`/`UNKNOWN_OUTCOME` rather than resent automatically. Members can list their deliveries and retry their own `FAILED` or `SKIPPED_NOT_CONFIGURED` ones (fresh attempt budget). The provider idempotency key is the delivery id.
- **Reports (T04).** `ChannelReportsService` reads M13 `listPublishedRecords` (verified PUBLISHED destinations) plus `PublishFailed` outbox events, M14 `listLatestSnapshots` (CHANNEL granularity, per connected YouTube account from `SocialAccountsService.list`), M15 `listChannelInsightsBetween` (period-bounded, exact totals), and M16 `countRunOutcomes`. Each section has `status` AVAILABLE / PARTIAL / NO_DATA / UNAVAILABLE. A metric total is reported only when every day of the period has a persisted AVAILABLE value; otherwise it is `null` and listed in `missingData` (`NO_ANALYTICS_ACCOUNT`, `NO_METRIC_SNAPSHOTS`, `INCOMPLETE_METRIC_SNAPSHOTS`, `PUBLISHED_RECORDS_TRUNCATED`, `PUBLISH_FAILURES_TRUNCATED`, `INSIGHT_REPORTS_TRUNCATED`, `RECOMMENDATIONS_TRUNCATED`, `*_UNAVAILABLE`). Capped lists: publish failures (200), insight reports (50), recommendations (100); each count (`failedCount`, `reportCount`, `recommendationCount`) is an exact DB count over the period, and a cut list marks the section `PARTIAL` with the matching `*_TRUNCATED` item (unit-tested per path). Published records keep their 5,000-row scan cap with `publishedCount = null` when hit. Periods: DAILY = one local day; WEEKLY = ISO Monday–Sunday. `startOfLocalDay` binary-searches the first instant of the local date, so 23 h / 25 h days and zones whose midnight is skipped are exact. Manual generation rejects periods that have not ended; repeats return the stored report (P2002 race handled). Scheduled tick: for every ACTIVE channel, the last completed daily and weekly period once it ended ≥ 2 h ago; PAUSED/ARCHIVED are suppressed. A new report and its `CHANNEL_REPORT_READY` event are inserted in one transaction (review R2; tested by failing the event insert and checking no report row exists).
- **Worker.** `NotificationsWorkerHandler` ticks every 30 s with an injectable clock: intake → report schedule tick → fan-out → due deliveries. Errors are reported and the loop continues; `stop()` (SIGINT/SIGTERM in `main.ts`) waits for the active tick and closes its Nest context.

## API
- `GET /workspaces/:workspaceId/notifications?unread=true&limit=&before=` → `{ items, unreadCount }` (mine only).
- `POST /workspaces/:workspaceId/notifications/:notificationId/read`, `POST …/notifications/read-all`.
- `GET|PUT /workspaces/:workspaceId/notifications/preferences` (PUT body `{ preferences: [{ eventType, inApp, email }] }`).
- `GET /workspaces/:workspaceId/notifications/deliveries`, `POST …/deliveries/:deliveryId/retry`.
- `GET /workspaces/:workspaceId/channel-reports?channelId=&periodType=&limit=`, `GET …/channel-reports/:reportId` (any member, VIEWER included); `POST …/channel-reports` `{ channelId, periodType, periodStartDate }` (OWNER/EDITOR).
- Every member reads and changes only their own notifications, preferences, and deliveries (another member's id is 404). Non-members get 403 from `WorkspaceService.context`; ids from another workspace are 404.

## Deep-link route shapes (T05, relative app routes)
- Failed job / run: `/workspaces/:workspaceId/orchestration/runs/:runId`
- Review item: `/workspaces/:workspaceId/reviews/:reviewRunId`
- Published post: `/workspaces/:workspaceId/publishing/posts/:scheduledPostId`
- Analytics detail: `/workspaces/:workspaceId/analytics/channels/:channelId/insight-reports/:reportId`
- Channel report: `/workspaces/:workspaceId/channels/:channelId/reports/:reportId`
The web app does not implement these routes yet; they are the contract for it.

## Commands and evidence (2026-11-10, after the review 5839809149 fixes; Node 24.22.2, pnpm 12.16.1, disposable `postgres:18.6-alpine` on 127.0.0.1:55438 dropped and recreated, `redis:7-alpine` on 127.0.0.1:56380 for the existing M16 Redis suite)
- `pnpm db:migrate:deploy` on the fresh DB: **passed**, 25 migrations including `20261116010000_m17_notifications_and_reporting`; the six intake indexes exist in `pg_indexes`.
- `pnpm install --frozen-lockfile`: **passed** (lockfile unchanged).
- `pnpm lint`: **passed**. `pnpm format:check`: **passed**. `pnpm typecheck`: **passed**.
- `DATABASE_URL=…55438 REDIS_URL=redis://127.0.0.1:56380 pnpm test`: **passed**. 64 files passed / 1 skipped (65); **431 tests passed / 5 skipped (436)**. The only skips are the existing 5 FFmpeg/ffprobe tests.
- Focused M17 (`vitest run apps/api/src/modules/notifications apps/worker/src/handlers/notifications`): 5 files, **27 tests passed**, run twice in a row against the same DB: Postgres integration 11, report assembly 6, periods/DST 4, catalog/links/backoff 4, worker handler 2.
- `pnpm build`: **passed**. `pnpm db:validate`: **passed**.
- `prisma migrate diff --from-config-datasource --to-schema`: no M17 drift (0 notification/channel_report/new-index lines); the remaining lines are the pre-existing FK/index naming drift.
- Earlier (`ef98793`): worker smoke `node apps/worker/dist/main.js` started, ran an intake tick, and exited 0 on SIGTERM.

## Acceptance evidence
- **Reports use only persisted/verified data:** sections read only the services listed above; unavailable sources produce `null`/`UNAVAILABLE` plus `missingData` (unit + integration tests).
- **Repeated delivery creates no duplicates:** second intake, full cursor reset, and forced re-fan-out leave event, notification, and delivery counts unchanged (integration).
- **Failed delivery is visible and retryable:** RETRY_WAIT with attempts and `nextAttemptAt = now + 60 s`, not sent before due, SENT on the next due run; non-retryable → FAILED with code; member retry endpoint (integration).
- **No fake email success:** NOT_CONFIGURED → every due delivery `SKIPPED_NOT_CONFIGURED` / `EMAIL_NOT_CONFIGURED`, `sent = 0`; in-app still delivered (integration).
- DST: New York 2026-03-08 = 23 h, 2026-11-01 = 25 h (also through the API: `2026-11-01T04:00Z`–`2026-11-02T05:00Z`), London 2026-03-29 = 23 h, a 169 h week; skipped-midnight zones (Santiago, Beirut) resolve to the first real instant.
- Roles/tenancy: VIEWER generate → 403, VIEWER list/get → OK; another member's notification/delivery → 404; other workspace report/notification → 404; non-member context → 403.
- Schedule: an ACTIVE channel gets exactly one DAILY (2026-11-09) and one WEEKLY (2026-11-02) report across two ticks; the PAUSED channel gets none.

## Contract/schema proposals
- Additive migration `20261116010000_m17_notifications_and_reporting` (Core-approved): enums `NotificationFanoutStatus`, `NotificationDeliveryStatus`, `ChannelReportPeriod`, `ChannelReportTrigger`; tables `notification_preferences`, `notification_events`, `notifications`, `notification_deliveries`, `notification_intake_cursors`, `channel_reports`; plus the six intake keyset indexes listed under Files changed (review B2). No `packages/contracts` change (module-local Zod schemas, like M16).

## Blockers / risks / unknowns
- No live email adapter (pending sender ADR). Email bodies carry relative links until a public base URL is configured.
- A row committed more than 30 s after its own timestamp (long transaction or clock skew beyond R1's assumption) is behind the cursor and is not notified.
- `PUBLISH_RECONCILIATION_REQUIRED` is keyed per destination and publish-job retry count; a second episode without a retry is not re-notified.
- M11 review-needed is detected from the run's current status, so a review that was decided before the intake ran is not notified as needed (its decision is).
- Reports: published records are paged workspace-wide (M13 API shape), capped at 5,000 rows per report (marked `PUBLISHED_RECORDS_TRUNCATED`); M15 report/recommendation lists are capped at 50 / 100 per period with exact totals; M14 metric days are platform calendar dates, not converted to the channel timezone. The scheduler does not backfill missed periods older than the latest completed one. An invalid channel timezone falls back to UTC.
- Fan-out reads the member list at fan-out time; members who join later do not get past events.
- The worker boots a third `AppModule` context (as composition and M16 already do).

## Next exact action
Minu review of the M17 PR. Do not merge until an official APPROVE. After merge, M18 rebases onto it (ADR-017).

## Handoff notes
No PROJECT_STATE edit (closeout PR does that). Containers `reelforge-m17-db` and `reelforge-m17-redis` were removed after verification.

## Review 5839809149 (REQUEST_CHANGES on `ef98793`) - fixes
- B1 intake cursor: strict `(ts, id)` keyset in all six readers, stall branch removed, fresh cursor at `now - settle` unless `intakeBackfill`. Tests: same-timestamp overflow across ticks; fresh cursor ignores older rows (and backfill picks them up).
- B2 indexes: six `(timestamp, id)` indexes in the M17 migration and `schema.prisma`.
- B3 report caps: exact counts plus `PARTIAL` / `*_TRUNCATED` for publish failures, insight reports, recommendations; insights read bounded to `(channel, from, to)`. Unit test per path; integration test for the bounded read.
- R2: report + `CHANNEL_REPORT_READY` in one transaction (integration test). R1: documented on `intakeSettleMs`.

## Reviewer decision
- 5839809149: REQUEST_CHANGES on `ef98793` (B1–B3, R1–R2); fixes pushed, re-review pending.
