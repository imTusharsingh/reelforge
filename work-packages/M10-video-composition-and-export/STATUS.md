# M10 Status - Video Composition & Export

- **State:** INTEGRATED
- **Assigned session/editor:** Module Implementation Agent
- **Branch/worktree:** `main` via PR #18
- **Last updated:** 2026-11-09
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** `2c6fcbb4cb056bd1d9fa4bd42790d59c38217e5a` (review `5829841015`)
- **Merge commit:** `7d00ced8be55bf9569fa699ff23a120a8a853bae`

## Current objective
Compose generated scene assets into a validated vertical video.

## Task checklist
- [x] M10-T01: T01 Define render profile and destination-neutral output specification.
- [x] M10-T02: T02 Validate source media, dimensions, codecs, frame rates, audio streams, and durations.
- [x] M10-T03: T03 Implement deterministic FFmpeg composition of scenes, transitions, narration, licensed music/SFX, and captions.
- [x] M10-T04: T04 Implement subtitles/caption timing and safe margins.
- [x] M10-T05: T05 Generate cover/thumbnail candidates from approved frames.
- [x] M10-T06: T06 Export final MP4 and metadata manifest; calculate checksum and duration.
- [x] M10-T07: T07 Implement render retry/cancel and output artifact retention.
- [x] M10-T08: T08 Support bounded edit operations: replace scene, audio, subtitle, title/cover, then rerender.


All assigned T01–T08 tasks were implemented and reviewed before PR #18 was integrated. This closeout records the verified approval and merge; no product rework is included.

## Integration closeout (2026-11-09)
- PR #18 was approved by Minu at head `2c6fcbb4cb056bd1d9fa4bd42790d59c38217e5a` (review `5829841015`) and squash-merged at `7d00ced8be55bf9569fa699ff23a120a8a853bae`.
- **Operational note, not a product blocker:** if an upload writer dies before recording completion, its pending-upload row remains discoverable and cleanup warns about it. The tenant-scoped `RESTRICT` relation blocks deletion of the associated render job until the row is resolved manually.
- Deployment still needs to schedule the worker's retry/recovery and retention passes. No product rework is included in this documentation closeout.

## Review blocker fix-forward (2026-11-07)
- **B1 cancellation/claim race:** cancel-before-claim and cancel-after-claim-before-controller-registration now terminalize to `CANCELED`; the claim path is atomic and a lost/canceled claim cannot execute the engine. Covered by the persisted cancellation/claim regression tests.
- **B2 stored artifact integrity:** manifest retrieval re-reads the stored video, every cover, and the manifest; each object's byte size and SHA-256 must match the bound artifact row or access fails closed. Tampered and missing video/cover cases are tested.
- **B3 source audio:** explicit per-scene audio precedence is enforced: a pinned narration track replaces source-video audio for that scene, while an accepted source video with audio and no separate narration has its source audio mapped into the composition instead of being replaced by silence. The real FFmpeg test verifies audible output, not just AAC stream presence.
- **B4 retry/recovery/retention:** scheduled claims are bounded by `attempt < maxRetries`, the first retry uses the base delay and later retries back off exponentially, exhausted jobs become `FAILED_FINAL`/`RETRY_EXHAUSTED`, stale exhausted `RUNNING` claims are terminalized instead of stranded, queued child jobs are recoverable, and manual retry children cannot extend the chain past `maxRetries`. Retention deletion is idempotent, so a partial deletion failure remains recoverable, and expired-access denial remains tested.
- **B5 PNG dimensions:** still sources must satisfy the profile-compatible PNG minimum dimensions before scaling; an undersized image is rejected with a validation error.

## Second re-review fix-forward (2026-11-07)
Minu's re-review at `cc6a8a7` confirmed B2/B5 pass and reopened B1, the B3 test fixture, and four B4 reliability gaps, plus Prisma schema/migration alignment.

- **B1 cross-instance cancellation:** the executor re-reads persisted `cancelRequestedAt`/`status` when any error is raised. If cancellation was requested by another instance (or the job is already `CANCELED`), cancellation wins over transient/permanent classification, the lease is cleared, and the job is terminalized to `CANCELED`. Tests cover cancel-before-claim, cancel during execution across service instances, and cancellation preserved across both transient and permanent renderer errors.
- **B3 test correction:** the no-narration engine test now explicitly clears the fixture's inherited narration refs and verifies the intended 880 Hz source signal is present while the narration fixture's 440 Hz band is absent, instead of relying on a generic volume threshold.
- **B4/1 stale live executor:** claim tokens are unique per claim rather than per service instance, artifact keys are claim-specific (`render/<jobId>/<leaseToken>/<filename>`), and a heartbeat renews the lease and aborts if the claim is lost. A superseded executor can no longer overwrite artifacts published by the worker that recovered its expired lease; its own objects are cleaned up. Tested with an interleaved stale executor and recovered worker.
- **B4/2 shared retry budget:** explicit retry atomically consumes the parent's retry budget in the same transaction that creates the child. A `FAILED_RETRYABLE` parent is superseded as `FAILED_FINAL`/`RETRY_SUPERSEDED` so the worker cannot also retry it; a `CANCELED` parent stays canceled while consuming one attempt. Concurrent fresh-key retries produce exactly one child, and same-key retries remain idempotent.
- **B4/3 unrecoverable retention lease:** retention claim uses `OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }]`, so a process crash mid-deletion no longer leaves the job permanently unclaimable. Deletion remains idempotent and the crash-recovery path is tested.
- **B4/4 worker poll outage:** the poller catches transient poll failures, reports them through an optional `onError` (falling back to `console.error`), and continues polling instead of stopping. Tested with a rejected poll followed by successful polls.
- **Schema alignment:** `RenderJob.parent` now uses the compound tenant relation `fields: [workspaceId, parentJobId], references: [workspaceId, id]`, matching the compound FK created by migration `20261106190000_m10_video_composition_export`.

## Third re-review fix-forward (2026-11-07)
Minu's re-review at `0ab8eb7` confirmed B1/B2/B3/B5 and the earlier B4 fixes, but identified two remaining B4 gaps: canceled parents could branch into sibling retry chains, and partial uploads could leave untracked storage objects.

- **B4.1 retry-family fencing:** each retryable or canceled parent can now produce at most one retry child. The transaction atomically consumes the shared attempt budget and records `retrySupersededAt`; canceled status, cancellation timestamp, and error history remain intact. Automatic claims honor the same fence. Descendant attempts inherit the family counter. Tests cover canceled-root descendants, concurrent fresh-key retries, and overlap between manual retry and automatic claims.
- **B4.2 upload cleanup:** every claim-specific object key is persisted before the first upload. Failed, timed-out, and partial writes retain a durable cleanup record; failed immediate deletion is logged and retried by the worker cleanup sweep after the upload deadline and grace window. Cleanup claims fence against renewed live jobs and published artifacts. Tests cover write-then-throw, deletion outage/recovery, late writes, live claims, and published-object protection.
- **Schema:** additive migration `20261107090000_m10_retry_supersession_and_pending_objects` adds the retry-family marker and tenant-scoped pending-object ledger.
- **Verification:** with Node `24.22.2`, pnpm `12.16.1`, isolated PostgreSQL `18.6`, and local FFmpeg/ffprobe `7.0.2`, `pnpm db:validate`, `pnpm db:migrate:deploy` (15 migrations), API typecheck/build, focused ESLint/Prettier, and all composition tests passed (4 files / 46 tests). `git diff --check` passed. The two hosted PR quality checks were green at the checked PR head `0ab8eb7`; they do not include this local fix-forward until it is pushed.

## Fourth re-review fix-forward (2026-11-07)
Minu's re-review at `bee630a` identified an unbounded late-write race in cleanup and a double attempt increment when a reserved retry child was recovered from `QUEUED`.

- **B4.1 upload quiescence:** pending-object rows now persist `uploadStartedAt` and `uploadCompletedAt`. A claim- and lease-guarded transaction marks an upload started before storage is called; the underlying storage promise records settlement whether it succeeds or fails. Sweeps may delete bytes for unresolved uploads but cannot remove their ledger row until a later sweep observes a settled writer and deletes again. Thus a write that lands after a sweep remains discoverable. Added a regression that deliberately sweeps before releasing the delayed writer, then verifies a later sweep removes the late object and tombstone.
- **B4.2 reserved attempts:** scheduled claims increment the attempt for root jobs, but not for queued child jobs whose attempt was reserved transactionally when the child was inserted. Subsequent execution retries still consume attempts. Added a persisted crash simulation that throws immediately after the retry transaction commits, then recovers the queued child and asserts one reserved attempt and one scheduled execution.
- **Schema:** additive migration `20261107100000_m10_pending_upload_quiescence` adds nullable upload-start and upload-completion timestamps to the pending-object ledger.
- **Verification:** with Node `24.22.2`, pnpm `12.16.1`, isolated PostgreSQL `18.6`, and local FFmpeg/ffprobe `7.0.2`, `pnpm db:validate` and `pnpm db:migrate:deploy` (16 migrations) passed; API typecheck/build and focused ESLint/Prettier passed; all composition tests passed (4 files / 46 tests). Hosted checks have not yet run on this local fix-forward.

## Fifth re-review fix-forward (2026-11-09)
Minu's re-review at `ffd4ea3` confirmed reserved-attempt recovery and the late-write race fix, but found that aged unfinished uploads could fill the bounded cleanup batch and starve completed orphans. It also requested completion recording for synchronous storage errors.

- **B4 unfinished-upload liveness:** the bounded cleanup query now selects only never-started or completed uploads. A separate count emits a warning for aged started-but-unfinished uploads; their ledger rows remain discoverable for diagnosis without blocking eligible cleanup records.
- **B4 synchronous storage errors:** if `putObject` throws before returning a promise, the pending row is marked complete before the original storage error is rethrown, allowing immediate cleanup to retire it safely.
- **Regression coverage:** with a batch size of 10, ten stale unfinished rows no longer block a newer completed orphan; the sweep deletes the orphan and warns with the stuck-row count. A synchronous `putObject` throw confirms completion was recorded before cleanup.
- **Verification:** Node `24.22.2`, pnpm `12.16.1`; all 16 migrations applied to a fresh local PostgreSQL `18.6` database. `pnpm --filter @reelforge/database db:generate` passed with `DATABASE_URL`; API TypeScript check and API build passed; the persisted composition integration file passed (1 file / 41 tests); focused ESLint, Prettier, and `git diff --check` passed. Hosted CI was not run for this fix-forward.

## Files changed
- `apps/api/src/app.module.ts`, `apps/api/package.json`: module registration and workspace media dependency.
- `apps/api/src/modules/composition/composition.controller.ts`: authenticated, workspace-member-scoped render HTTP contract.
- `composition.types.ts`, `composition.validation.ts`: schema 1.0 request contract, pinned profile, rendition semantics, captions and bounded edition operations.
- `composition.module.ts`: injectable engine/process and existing asset/storage wiring.
- `composition.engine.ts`: source identity/rights/checksum validation, safe argv-only child processes, cleanup/cancellation, deterministic CUT/FADE composition, exact timestamp covers, profile/ffprobe final validation and export manifest generation.
- `composition.service.ts`: M09 exact active-scene/output and pin validation, music/SFX authorized asset resolution, deterministic canonical create/retry identity, cancellation, bounded replace/rerender, transactional artifacts and lifecycle finalization, durable bounded retry/recovery, retry-family fencing, pending-upload cleanup, and retention sweeping.
- `composition.manifest.ts`: two-phase manifest validation before publish and stored retrieval checksum/input/artifact binding.
- `composition.integration.test.ts`: persisted lifecycle, source pin/security, edit family, cancel-before-claim and cross-instance cancellation (transient and permanent errors), manifest tamper, bounded retry/exhaustion, concurrent fresh-key retries, stale live-executor fencing, stale-claim recovery, retention crash recovery, and retention cases.
- `apps/worker/src/handlers/composition/**`, `apps/worker/src/main.ts`, `apps/worker/tsconfig*.json`, `apps/api/package.json`: durable composition poller wiring, explicit API subpath exports, and build-time declaration resolution. The temporary `apps/api/types/*` re-export scaffolding was removed.
- `composition.http.integration.test.ts`: actual AuthGuard + membership/editor boundary requests.
- `composition.unit.test.ts`: cover bounds and child abort listener cleanup when FFprobe is configured.
- `composition.engine.integration.test.ts`: real local FFmpeg CUT/FADE renders, music/SFX, captions, two exact timestamp covers, H264/AAC output, manifest SHA-256/duration, byte-identical repeated render, and 880 Hz source-audio presence with 440 Hz narration-band absence.
- `packages/media/src/index.ts`, `packages/media/src/media.test.ts`: pinned output specification, strict numeric FFprobe parser, argument builder with no shell, timed captions/audio, canonical fingerprint and validation error classes.
- `packages/media/package.json`, `packages/media/tsconfig*.json`, `pnpm-lock.yaml`, `vitest.config.ts`: source/test package wiring; tests excluded from distributable declarations.
- `packages/database/prisma/schema.prisma` + migrations `20261106190000_m10_video_composition_export`, `20261106220000_m10_retry_recovery_retention`, `20261107090000_m10_retry_supersession_and_pending_objects`, and `20261107100000_m10_pending_upload_quiescence`: additive render lifecycle, retry/recovery, and pending-upload cleanup schema.
- `docs/PROJECT_STATE.md`, `docs/WORK_LOG.md`, `work-packages/M09-scene-media-generation/STATUS.md`: historical M09 closeout and M10 implementation-era project snapshot; current M10 integration is recorded above.

## Commands and evidence
Environment on TRACXN-LP-784: Node `24.22.2` via nvm, pnpm `12.16.1`, Docker PostgreSQL on localhost `55433`, fresh `reelforge_m10_rereview` created for this rerun, local filesystem asset storage. Real FFmpeg used only through `FFMPEG_PATH="$PWD/.local-tools/ffmpeg"` and `FFPROBE_PATH="$PWD/.local-tools/ffprobe"` at `7.0.2-static`; these tools are not committed.

- `pnpm install --frozen-lockfile` — **PASSED** on Node 24.22.2; existing frozen lockfile unchanged by install/supply chain check.
- `pnpm db:validate` — **PASSED**, valid Prisma schema with the compound tenant parent relation.
- `pnpm db:migrate:deploy` — **PASSED** on a newly created empty `reelforge_m10_rereview`, all 14 migrations including `20261106190000_m10_video_composition_export` with the compound `render_jobs_parent_fkey` `(workspace_id, parent_job_id) → (workspace_id, id)`.
- `pnpm lint` — **PASSED**, exit 0.
- `pnpm format:check` — **PASSED**, all checked repository files match Prettier.
- `pnpm typecheck` — **PASSED** for all workspaces with `DATABASE_URL`, including the worker's explicit API subpath imports.
- Focused `pnpm exec vitest run apps/api/src/modules/composition/composition.integration.test.ts apps/api/src/modules/composition/composition.engine.integration.test.ts packages/media/src/media.test.ts apps/worker/src/handlers/composition/composition.test.ts` with configured DB/binaries — **PASSED**, 4 files / 48 tests, including cross-instance cancellation over transient/permanent errors, stale live-executor fencing, concurrent retry-budget consumption, retention crash recovery, worker poll-outage continuation, 880/440 Hz source-audio bands, and undersized-PNG rejection.
- Full `pnpm test` with DB and binary paths, `CI=1` — **PASSED**, 35 files / 225 tests, zero failed and zero skipped. This run includes all configured-FFmpeg gated tests.
- `pnpm build` — **PASSED** with `DATABASE_URL` set; Next and all recursive TypeScript builds exited 0. Built worker probe `timeout 3s node apps/worker/dist/main.js` started without module/runtime errors and ended only by the intentional timeout (exit 124).
- `git diff --check` — **PASSED** on final candidate.
- Documentation edits and CI status do not change the above program verdict; Minu/hosted CI must independently review the pushed head.

No live AI, social or other external provider was called. Video test assets are deterministic local fixtures (red/blue PNGs and sine WAV/music), not user data. Re-render checksum equality holds for the tested pinned inputs and pinned FFmpeg build; it is not a promise across arbitrary other FFmpeg builds.

## Contract/schema proposals
- Additive schema authorized for the M10 assignment: `RenderJob` (`QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED_RETRYABLE`, `FAILED_FINAL`, `CANCELED`) and `RenderArtifact` (`VIDEO`, per-request `COVER`, `MANIFEST`) reference workspace, user creator, parent M09 package and pinned asset rows. Both use transactions/publish-cleanup to suppress successful persistence of invalid or failed outputs; source failures never cite a synthetic `SUCCEEDED` media row.
- No existing database migration, `packages/contracts`, unrelated module or shared route registry was modified. M10 HTTP is registered by `apps/api/src/app.module.ts` via the work package's Nest API structure.
- Do not share or commit outside storage credentials. The requested FFmpeg execution paths are local environment overrides, not persisted secrets or credentials.
- Manifest schema remains `1.0`; generated pre-persist manifest includes title/seed/profile, M09 package pin, exact scenes/audio/covers, MP4 byte size/checksum/duration and artifact order. The service rebinds server-created video/cover artifact ids/object keys/checksums/size and rejects mismatch/tampered JSON. The preferred M11/M13 consumer reads the validated manifest from the same-workspace render job.

## Blockers / risks / unknowns
- **Integrated:** M10 has Minu's approval and is merged through PR #18. The operational dead-writer cleanup note above remains for operator handling; it is not a product blocker.
- Render composition currently runs inline in the API service call. The built worker separately polls and claims queued, retryable, and stale-running render jobs, so a process restart can recover durable work; deployment still needs to run the worker process. An injected queue abstraction was not introduced because it would be an architecture change requiring Core review.
- Retry permits only failed retryable/canceled parents and attempts the same pinned input with a fresh idempotency key. Explicit retry atomically consumes the shared retry budget; a retryable parent is superseded as `FAILED_FINAL`/`RETRY_SUPERSEDED`, while a canceled parent stays canceled but still consumes one attempt. Worker claims persist a 1-based execution attempt, enforce `attempt < maxRetries`, recover expired leases, and exhaust to `FAILED_FINAL`/`RETRY_EXHAUSTED` without stranding `RUNNING` jobs. Manual retry children are rejected once the retry budget is exhausted. New input/parent/retention combinations fail as conflicts.
- `retentionDays` (1–3650) and `retainedUntil` are persisted on every successful artifact. The worker retention pass claims due outputs, reclaims leases left by a crashed retention process, deletes every stored artifact idempotently, marks expiry, and denies later access; failed deletion releases the claim for a later retry. Deployment still needs to schedule this pass.
- Real FFmpeg is exercised locally through explicit binary paths; hosted CI without those binaries will skip the opt-in render tests. No live provider or network call is used.
- Source media is deliberately bounded to generated vertical H264/30/1080x1920 video plus profile-compatible PNG stills per M09's source shape; failed source format/dimension/duration/codec is FAILED_FINAL, not blindly retried.
- Earlier M04 compiled-dist ESM boot follow-up still applies to the API process; the M10 built-worker startup probe is not a full production API process smoke.
- There is no user UI, social export or provider generation here. No change to M11 approval/status or M13 publication behavior.

## Next exact action
No further M10 product work is assigned. Continue with M11 only after this docs-only closeout PR merges, starting from the new `origin/main` tip.

## Handoff notes
Endpoint family: `POST /workspaces/:workspaceId/composition/jobs`, `GET /jobs/:jobId`, `GET /jobs/:jobId/manifest`, and editor-only `POST /jobs/:jobId/{retry,cancel,edit}`. AuthGuard obtains sessions; existing WorkspaceService resolves membership. Scene visual/narration, cover assets, and additional music/SFX must reference published, rights-aware current-workspace assets. Raw FFmpeg exit statuses sanitized; raw command/media paths not exposed in REST error mapping. Cancellation and no-successful-artifact cleanup fail closed.

## Reviewer decision
- **INTEGRATED:** Minu approved PR #18 head `2c6fcbb4cb056bd1d9fa4bd42790d59c38217e5a` (review `5829841015`); squash merge `7d00ced8be55bf9569fa699ff23a120a8a853bae`. This status records reviewer/merge evidence, not self-approval.

## Workstream C integration closeout — 2026-11-13 (#80)

C4 start render from successful scene production; C3 #97 also accepts ASSIGNED outputs in composition landed via [PR #96](https://github.com/imTusharsingh/reelforge/pull/96), reviewed head `717b621256a7490194316b7e8b64d305d57a0dd6`, main merge `1409ae05540a7bef21d469ea13a4fd7ccccd8d8a`. Earlier follow-up pending-review text is historical; no new implementation approval or live verification is claimed. Cross-flow E2E remains #79.
