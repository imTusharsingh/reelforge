# M10 Status - Video Composition & Export

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Module Implementation Agent
- **Branch/worktree:** `work/m10-video-composition-and-export` (Desktop local execution, short branch prefix used by this repository).
- **Last updated:** 2026-11-06
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** none

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


All assigned T01–T08 tasks are implemented (100% implementation scope estimate, not approval). The module is ready for Minu review, not for maintainer/API adoption without that review.

## Files changed
- `apps/api/src/app.module.ts`, `apps/api/package.json`: module registration and workspace media dependency.
- `apps/api/src/modules/composition/composition.controller.ts`: authenticated, workspace-member-scoped render HTTP contract.
- `composition.types.ts`, `composition.validation.ts`: schema 1.0 request contract, pinned profile, rendition semantics, captions and bounded edition operations.
- `composition.module.ts`: injectable engine/process and existing asset/storage wiring.
- `composition.engine.ts`: source identity/rights/checksum validation, safe argv-only child processes, cleanup/cancellation, deterministic CUT/FADE composition, exact timestamp covers, profile/ffprobe final validation and export manifest generation.
- `composition.service.ts`: M09 exact active-scene/output and pin validation, music/SFX authorized asset resolution, deterministic canonical create/retry identity, cancellation, bounded replace/rerender, transactional artifacts and lifecycle finalization.
- `composition.manifest.ts`: two-phase manifest validation before publish and stored retrieval checksum/input/artifact binding.
- `composition.integration.test.ts`: persisted lifecycle, source pin/security, edit family, cancellation and manifest tamper cases.
- `composition.http.integration.test.ts`: actual AuthGuard + membership/editor boundary requests.
- `composition.unit.test.ts`: cover bounds and child abort listener cleanup when FFprobe is configured.
- `composition.engine.integration.test.ts`: real local FFmpeg CUT/FADE renders, music/SFX, captions, two exact timestamp covers, H264/AAC output, manifest SHA-256/duration, and byte-identical repeated render.
- `packages/media/src/index.ts`, `packages/media/src/media.test.ts`: pinned output specification, strict numeric FFprobe parser, argument builder with no shell, timed captions/audio, canonical fingerprint and validation error classes.
- `packages/media/package.json`, `packages/media/tsconfig*.json`, `pnpm-lock.yaml`, `vitest.config.ts`: source/test package wiring; tests excluded from distributable declarations.
- `packages/database/prisma/schema.prisma` + `prisma/migrations/20261106190000_m10_video_composition_export/migration.sql`: additive `RenderJob` / `RenderArtifact`, links to M09 and assets, constrained fingerprints/checksums/retention and idempotency.
- `docs/PROJECT_STATE.md`, `docs/WORK_LOG.md`, `work-packages/M09-scene-media-generation/STATUS.md`: closeout of integrated M09 plus this M10 pending-review snapshot.

## Commands and evidence
Environment on TRACXN-LP-784: Node `24.22.2` via nvm, pnpm `12.16.1`, Docker PostgreSQL `18.6-alpine` on localhost `55433`, fresh `reelforge_m10_work`, local filesystem asset storage. Real FFmpeg used only through `FFMPEG_PATH="$PWD/.local-tools/ffmpeg"` and `FFPROBE_PATH="$PWD/.local-tools/ffprobe"` at `7.0.2-static`; these tools are not committed.

- `pnpm install --frozen-lockfile` — **PASSED** on Node 24.22.2; existing frozen lockfile unchanged by install/supply chain check.
- `pnpm db:validate` — **PASSED**, valid Prisma schema.
- `pnpm db:migrate:deploy` — **PASSED**, fresh database, all 14 migrations including additive `20261106190000_m10_video_composition_export` and `20261106220000_m10_retry_recovery_retention`.
- `pnpm lint` — **PASSED** exit 0 after explicit controller/service returns and test cleanup.
- `pnpm format:check` — **PASSED**, all checked repository files match Prettier.
- `pnpm typecheck` — **PASSED** for all workspaces, with Prisma generation checked separately.
- Focused `pnpm exec vitest run apps/api/src/modules/composition/composition.integration.test.ts apps/api/src/modules/composition/composition.engine.integration.test.ts` with configured DB/binaries — **PASSED**, 2 files / 27 tests, including stale-lease recovery, concurrent claims, bounded retry/backoff, retention deletion, real CUT/FADE renders, multi-cover output, and source-audio coverage.
- Full `pnpm test` with DB and binary paths, `CI=1` — **PASSED**, 35 files / 217 tests, zero failed and zero skipped. This run includes all configured-FFmpeg gated tests.
- `pnpm build` — **PASSED** with `DATABASE_URL` set; Next and all recursive TypeScript builds exited 0. Built worker probe `timeout 3s node apps/worker/dist/main.js` started without module/runtime errors and ended only by the intentional timeout.
- `git diff --check` — **PASSED** on final candidate.
- Documentation edits and CI status do not change the above program verdict; Minu/hosted CI must independently review the pushed head.

No live AI, social or other external provider was called. Video test assets are deterministic local fixtures (red/blue PNGs and sine WAV/music), not user data. Re-render checksum equality holds for the tested pinned inputs and pinned FFmpeg build; it is not a promise across arbitrary other FFmpeg builds.

## Contract/schema proposals
- Additive schema authorized for the M10 assignment: `RenderJob` (`QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED_RETRYABLE`, `FAILED_FINAL`, `CANCELED`) and `RenderArtifact` (`VIDEO`, per-request `COVER`, `MANIFEST`) reference workspace, user creator, parent M09 package and pinned asset rows. Both use transactions/publish-cleanup to suppress successful persistence of invalid or failed outputs; source failures never cite a synthetic `SUCCEEDED` media row.
- No existing database migration, `packages/contracts`, unrelated module or shared route registry was modified. M10 HTTP is registered by `apps/api/src/app.module.ts` via the work package's Nest API structure.
- Do not share or commit outside storage credentials. The requested FFmpeg execution paths are local environment overrides, not persisted secrets or credentials.
- Manifest schema remains `1.0`; generated pre-persist manifest includes title/seed/profile, M09 package pin, exact scenes/audio/covers, MP4 byte size/checksum/duration and artifact order. The service rebinds server-created video/cover artifact ids/object keys/checksums/size and rejects mismatch/tampered JSON. The preferred M11/M13 consumer reads the validated manifest from the same-workspace render job.

## Blockers / risks / unknowns
- **Still open for review:** M10 is not approved, merged or production-complete until Minu independently checks T01–T08 and boundaries.
- Render composition currently runs inline in the API service call. Cancellation is in-process; a restart cannot resume a queued/running render automatically. An injected worker queue was not introduced because it would be an architecture change requiring Core review.
- Retry permits only failed retryable parents and attempts the same pinned input with a fresh idempotency key. Worker claims persist a 1-based execution attempt, enforce bounded retry/backoff, recover expired leases, and exhaust durably. Manual new input/parent/retention combinations fail as conflicts.
- `retentionDays` (1–3650) and `retainedUntil` are persisted on every successful artifact. The worker retention pass claims due outputs, deletes every stored artifact, marks expiry, and denies later access; failed deletion releases the claim for a later retry. Deployment still needs to schedule this pass.
- Real FFmpeg is exercised locally through explicit binary paths; hosted CI without those binaries will skip the opt-in render tests. No live provider or network call is used.
- Source media is deliberately bounded to generated vertical H264/30/1080x1920 video and absent-audio PNG stills per M09's source shape; failed source format/duration/codec is FAILED_FINAL, not blindly retried. Underlying decoding/pixel dimensions for stills are dependency-management review items after this baseline.
- Earlier M04 compiled-dist ESM boot follow-up still applies; this-stage `pnpm build` is not a production process smoke.
- There is no user UI, social export or provider generation here. No change to M11 approval/status or M13 publication behavior.

## Next exact action
Minu reviews the pending PR/head, reproduction and security/tenant evidence, and decides whether explicit worker execution, retention sweeping or retry scheduling are required before approval. Do not merge/approve from the implementation agent.

## Handoff notes
Endpoint family: `POST /workspaces/:workspaceId/composition/jobs`, `GET /jobs/:jobId`, `GET /jobs/:jobId/manifest`, and editor-only `POST /jobs/:jobId/{retry,cancel,edit}`. AuthGuard obtains sessions; existing WorkspaceService resolves membership. Scene visual/narration, cover assets, and additional music/SFX must reference published, rights-aware current-workspace assets. Raw FFmpeg exit statuses sanitized; raw command/media paths not exposed in REST error mapping. Cancellation and no-successful-artifact cleanup fail closed.

## Reviewer decision
- Pending Minu review. Not approved, not integrated, no merged commit claimed. See M10 STATUS/WORK_PACKAGE for completion estimate rather than self-approval.
