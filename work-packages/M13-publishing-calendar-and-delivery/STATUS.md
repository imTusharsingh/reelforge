# M13 Status - Publishing Calendar & Delivery

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Completion estimate:** 100% of assigned T01-T08 implementation; review and integration pending.
- **Assigned session/editor:** Module Implementation Agent
- **Branch/worktree:** `work/m13-publishing-calendar-and-delivery` / `reelforge-m13`
- **Base:** post-M12-closeout `origin/main` at `1a3436db300d34e23810d2e17992921f488d478c`
- **Last updated:** 2026-11-10
- **Reviewer:** Minu (Core Architect)
- **Approved commit:** none

## Current objective
Deliver a workspace-scoped publishing calendar and manual YouTube publishing workflow. Instagram and unconfigured scheduling/budget dependencies remain fail-closed.

## Task checklist
- [x] M13-T01: Strict YouTube/Instagram destination metadata and explicit disclosure decision contracts.
- [x] M13-T02: Workspace-scoped scheduled-post creation, read, calendar listing, update, cancel, and reschedule API.
- [x] M13-T03: Preflight rechecks current M11 approval/hard gates, media integrity, metadata, explicit disclosure, M12 account health/status, scope/capability, schedule, budget, and encrypted-session readiness.
- [x] M13-T04: Fixture-tested YouTube resumable upload, offset reconciliation, and remote result verification through M12's authenticated client.
- [x] M13-T05: Per-destination jobs, attempts, states, timestamps, errors, remote IDs, and published events.
- [x] M13-T06: Workspace-scoped idempotency keys and conservative reconciliation before retries after uncertain upload outcomes.
- [x] M13-T07: Retry, reschedule, cancel, and explicitly manual publish API actions.
- [x] M13-T08: Instagram destinations are accepted as metadata but all publish preflight and execution remain fail-closed until M12 configures an approved adapter.

## Public M14 export
- Contract: `PublishedPostRecord` / `PublishedPostRecordSchema` from `@reelforge/contracts`.
- Service: `PublishingService.listPublishedRecords(context, after?, limit?, afterId?)`, exported as `@reelforge/api/publishing-service`. The `(publishedAt, id)` cursor keeps pagination stable when timestamps tie.
- API: `GET /workspaces/:workspaceId/publishing/published-records`.
- Each record contains workspace/channel, scheduled post, destination, job, render, account, platform, remote platform post ID, and publication timestamp.

## YouTube documentation verified
- `videos.insert`: https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- Resumable upload protocol: https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol
- `videos.list` verification: https://developers.google.com/youtube/data/reference/rest/v3/videos/list
- Implementation uses `videos.insert` with resumable initiation, acknowledged-byte status checks, and `videos.list` verification. No live upload was performed or authorized.

## Files changed
- `apps/api/package.json`
- `apps/api/src/app.module.ts`
- `apps/api/src/modules/publishing/publishing.controller.ts`
- `apps/api/src/modules/publishing/publishing.module.ts`
- `apps/api/src/modules/publishing/publishing.ports.ts`
- `apps/api/src/modules/publishing/publishing.service.ts`
- `apps/api/src/modules/publishing/publishing.service.test.ts`
- `apps/api/src/modules/publishing/publishing-session-vault.ts`
- `apps/api/src/modules/publishing/publishing-session-vault.test.ts`
- `apps/api/src/modules/publishing/publishing.types.ts`
- `apps/api/src/modules/publishing/publishing.validation.ts`
- `apps/api/src/modules/publishing/publishing.validation.test.ts`
- `apps/api/src/modules/quality/quality.service.ts`
- `apps/api/src/modules/social-accounts/social-accounts.service.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/publishing.ts`
- `packages/contracts/src/publishing.test.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261110120000_m13_publishing_calendar_and_delivery/migration.sql`
- `packages/database/src/index.ts`
- `packages/social-providers/src/types.ts`
- `packages/social-providers/src/youtube.connector.ts`
- `packages/social-providers/src/youtube.connector.test.ts`
- `docs/WORK_LOG.md`
- This status file.

## Verification evidence
Toolchain: Node `24.22.2`, pnpm `12.16.1`.

- `pnpm install --frozen-lockfile` — **passed**.
- `pnpm lint` — **passed** on final tree.
- `pnpm format:check` — **passed** on final tree.
- `pnpm typecheck` with `DATABASE_URL` pointing only to the disposable PostgreSQL on `127.0.0.1:55435` — **passed** across all workspaces.
- `pnpm test` with `DATABASE_URL` set to the disposable PostgreSQL on `127.0.0.1:55435` — **passed**: 45 test files passed, 1 skipped; 297 tests passed, 5 skipped. The skips are:
  - `apps/api/src/modules/composition/composition.unit.test.ts` — `SpawnProcessRunner` test requires `FFPROBE_PATH`.
  - Four tests in `apps/api/src/modules/composition/composition.engine.integration.test.ts` — real FFmpeg export tests require `FFMPEG_PATH` and `FFPROBE_PATH`.
  No live social/provider calls.
- `pnpm build` — **passed**.
- `pnpm db:validate` with the disposable database URL — **passed**.
- `pnpm db:migrate:deploy` on a fresh PostgreSQL 18.6 database bound only to host port `55435` — **passed**, all 20 migrations applied including M13; a second deploy reported no pending migrations.
- `git diff --check` — **passed** after final documentation update.
- Initial Prisma/typecheck invocations without `DATABASE_URL` failed to load Prisma config; reruns with the disposable port-55435 URL passed. An earlier lint/format run identified and fixed unused imports and formatting; final runs passed.

## PR #24 review follow-up
- Added fixture-only service coverage for current M11 approval revalidation, disclosure text, Instagram fail-closed behavior, viewer/cross-workspace publish/retry/reconcile denial, session persistence failures, completed upload verification, and the workspace-scoped published-record export.
- A new resumable session is encrypted and persisted immediately after upload initiation, with bounded persistence retries; only after persistence succeeds can the attempt enter reconciliation-required. Retry attempts copy the prior session ciphertext transactionally with the new attempt claim.
- `pnpm test` with the disposable database URL passed: 45 test files passed, 1 skipped; 297 tests passed, 5 skipped. All five skips and their missing FFmpeg/ffprobe prerequisites are listed above.

## Contract/schema changes
- Core Architect explicitly authorized additive M13 Prisma models/migration and contracts, plus the minimal M12 authenticated YouTube client extension for upload operations. No applied migration was reordered or edited.
- M12 now checks connected status, healthy state, granted upload scope, executable capability, and configured connector at each upload operation. M13 does not handle OAuth tokens.
- No OAuth scope change, analytics implementation, M16 scheduler, M18 budget implementation, or live provider action was added.

## Blockers, risks, and known gaps
- Default scheduling and budget ports deny preflight until M16/M18 integrations are configured; publishing is intentionally unavailable while either is unconfigured.
- Instagram upload execution remains disabled until M12's Instagram connector and approval decisions are complete.
- Resumable session URIs are encrypted with AES-256-GCM using `PUBLISH_SESSION_ENCRYPTION_KEY` (32-byte base64url). Production KMS delivery/rotation is still open.
- Existing connected accounts with stale capability snapshots fail closed until M12 records executable upload capabilities again.
- M10's current `StoragePort.getObject()` returns the full video as a `Buffer`; very large media may require a streaming storage/upload boundary before production-scale delivery.
- No scheduler/worker execution or web UI is included; this package exposes manual API actions only.

## Handoff notes
- PR #24 is open at https://github.com/imTusharsingh/reelforge/pull/24 at review-fix commit `18eebd88714ea993f5c4503ccdcaba221fe0eba4`; Minu has been requested for re-review.
- Implementation remains pending Minu's independent review; this session has not approved, merged, or pushed to `main`.
- M13's published-record contract/service above is ready for Bot 2 to wire after M13 integrates.
- Exact next action: await Minu's re-review; do not merge.
