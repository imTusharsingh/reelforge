# M09 Status - Scene Media Generation

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Module Implementation Agent
- **Branch/worktree:** `cursor/m09-scene-media-generation-1810`
- **Last updated:** 2026-11-06
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** none

## Current objective
Generate image/video/voice assets for each storyboard scene.

## Task checklist
- [x] M09-T01: Versioned scene generation job and asset output contract. Each scene has its own status and idempotency key.
- [x] M09-T02: Resolve prompt, configuration snapshot, and published character reference package per scene.
- [x] M09-T03: Generate scene images through an injectable image capability. The runtime default is fail-closed.
- [x] M09-T04: Generate motion only when the provider capability kind is `video` and the scene duration is inside the declared range. Otherwise fail closed.
- [x] M09-T05: Generate narration and dialogue through the TTS capability and the published character voice configuration. Missing voice or TTS capability fails closed.
- [x] M09-T06: Retry, regenerate, and replace one scene or output without redispatching successful scenes or successful outputs.
- [x] M09-T07: Persist provider job IDs, asset IDs, metadata, source references, and M08 ledger/budget rows for every real dispatch, including failures.
- [x] M09-T08: Validate media type, non-empty size, and checksum, bind the asset to the scene version, and export a complete package for M10.

Assigned tasks T01–T08 are implemented and awaiting review. That estimate is not approval.

## Files changed
- `apps/api/src/modules/scene-media/**`: job API, resolution, dispatch, retry/replace, validation, budget ledger, and tests.
- `apps/api/src/app.module.ts`: register the scene-media module.
- `packages/ai-providers/src/index.ts`: media bytes on image, video, and TTS responses, plus provider tokens.
- `packages/database/prisma/schema.prisma` and `packages/database/prisma/migrations/20261106180000_m09_scene_media_generation/migration.sql`: additive scene job, generation, and output tables.
- `docs/PROJECT_STATE.md`, `docs/WORK_LOG.md`, M07 `STATUS.md`, M08 `STATUS.md`: record the PR #16 integration and this M09 handoff.

## Commands and evidence
Node `24.22.2`, pnpm `12.16.1`, local PostgreSQL `16.15` (CI image is `18.6-alpine`; this session did not run that image). Fresh database `reelforge` on `127.0.0.1`.

- `pnpm install --frozen-lockfile` — **PASSED** (exit 0).
- `pnpm lint` — **PASSED** (exit 0).
- `pnpm format:check` — **PASSED** (exit 0).
- `pnpm typecheck` — **PASSED** (exit 0).
- `pnpm db:validate` — **PASSED** (exit 0).
- `pnpm db:migrate:deploy` — **PASSED** (exit 0). 12 migrations applied, including `20261106180000_m09_scene_media_generation`.
- `pnpm test` — **PASSED**, 29 files / 161 tests.
- `pnpm build` — **PASSED** (exit 0).
- `git diff --check` — **PASSED** (exit 0).

No live provider call was made. Scene-media tests inject fixture ports and local filesystem storage.

## Contract/schema proposals
- Additive Prisma models `SceneMediaJob`, `SceneGeneration`, and `SceneGenerationOutput` are included in this PR because the M09 assignment authorized additive schema changes. Prior migrations were not rewritten. A database check rejects `SUCCEEDED` and `REUSED` rows that lack a positive byte size, checksum, media type, or provider asset id.
- `packages/contracts` was not edited. `packages/ai-providers` now requires `media.body` on image, video, and TTS responses so generated files can be validated. Architecture already assigns that package to M08/M09. No vendor adapter was added.
- The cloud branch policy required `cursor/m09-scene-media-generation-1810`. The work-package convention remains `work/m09-*`.

## Blockers / risks / unknowns
- Review is pending. This status is not approval, integration, or a production-readiness claim.
- Runtime image, video, and TTS ports are unconfigured and fail closed. A real vendor adapter still requires the open provider decision and an explicit credential registration. Health checks run only on the authenticated provider-health route.
- Budget SQL matches the M08 reservation, settlement, release, and unknown-cost rules, but it is duplicated in the scene-media module so M07-owned script files were not edited. A refused daily cap rolls the pending ledger insert back inside the same transaction. The script path can leave that pending row committed when the reservation insert matches nothing.
- Generation runs in the API request, not the worker. A crash after a provider accepts work and before the success transaction commits can leave the scene unfinished. Retry creates a new scene version and can dispatch again.
- Cross-day settlement uses the same SQL shape as M08 and was not given its own integration case here.
- The post-M04 Prisma compiled-dist ESM boot follow-up remains open and was not changed.

## Next exact action
Minu reviews the M09 pull request. Do not merge. Do not start M10.

## Handoff notes
Create a job from an approved script revision that already points at an owned config/prompt snapshot pair. Image output is required. Video is dispatched only for a `video` capability. Narration and dialogue are dispatched only when the scene has text and a published character voice. Export returns schema `1.0` only when every active scene output is bound to published, non-empty, checksummed media. Successful outputs are copied forward on retry and replace.

## Reviewer decision
- Pending.
