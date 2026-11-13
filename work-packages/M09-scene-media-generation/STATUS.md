# M09 Status - Scene Media Generation

- **State:** INTEGRATED
- **Assigned session/editor:** Module Implementation Agent
- **Branch/worktree:** `main` (PR #17)
- **Last updated:** 2026-11-06
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** `589d28c86feaede46f516bf27555f02802882610` (PR #17 squash merge; reviewed head `99b1972191038f5e4f839892bbbb196e554d6215`)

PR #17 B1 re-review found the technical criteria met at `99b1972191038f5e4f839892bbbb196e554d6215`, with exact-head run `42222606082` / job `127908073738` green. Official `APPROVE` could not be self-posted because the reviewer authored the PR; Minu subsequently squash-merged PR #17 on main at `589d28c86feaede46f516bf27555f02802882610`. This entry records that established integration, not a new implementation-agent approval.

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
- `pnpm test` — **PASSED**, 29 files / 174 tests, after the B1 ledger fix. The earlier pre-fix run was 29 files / 161 tests.
- `pnpm build` — **PASSED** (exit 0).
- `git diff --check` — **PASSED** (exit 0).
- GitHub Actions on the pre-fix head passed ([run 42220724790](https://github.com/imTusharsingh/reelforge/actions/runs/42220724790)). The B1 commit is verified locally above; its hosted run is the PR check and is not copied here in advance.

No live provider call was made. Scene-media tests inject fixture ports and local filesystem storage.

## Contract/schema proposals
- Additive Prisma models `SceneMediaJob`, `SceneGeneration`, and `SceneGenerationOutput` are included in this PR because the M09 assignment authorized additive schema changes. Prior migrations were not rewritten. A database check rejects `SUCCEEDED` and `REUSED` rows that lack a positive byte size, checksum, media type, or provider asset id.
- `packages/contracts` was not edited. `packages/ai-providers` now requires `media.body` on image, video, and TTS responses so generated files can be validated. Architecture already assigns that package to M08/M09. No vendor adapter was added.
- The cloud branch policy required `cursor/m09-scene-media-generation-1810`. The work-package convention remains `work/m09-*`.

## Blockers / risks / unknowns
- Historical M09 implementation/provider operational risks below remain open. The M10 snapshot records that M09 PR #17 has integrated; it does not make new provider-production-readiness claims.
- [Historical pending-review note retained for audit context] Review had been pending again after the B1 ledger fix. This was superseded by the main integration recorded in this document header.
- Malformed or partial provider envelopes now normalize before the ledger write. Omitted usage is stored as JSON null, not `DbNull`. A post-dispatch ledger write is terminal (`SUCCEEDED` or `FAILED`); a failed finalization is not swallowed into a synthetic `PENDING` row.
- Runtime image, video, and TTS ports are unconfigured and fail closed. A real vendor adapter still requires the open provider decision and an explicit credential registration. Health checks run only on the authenticated provider-health route.
- Budget SQL matches the M08 reservation, settlement, release, and unknown-cost rules, but it is duplicated in the scene-media module so M07-owned script files were not edited. A refused daily cap rolls the pending ledger insert back inside the same transaction. The script path can leave that pending row committed when the reservation insert matches nothing.
- Generation runs in the API request, not the worker. A crash after a provider accepts work and before the success transaction commits can leave the scene unfinished. Retry creates a new scene version and can dispatch again.
- Cross-day settlement uses the same SQL shape as M08 and was not given its own integration case here.
- The post-M04 Prisma compiled-dist ESM boot follow-up remains open and was not changed.

## Next exact action
M09 is integrated. M10 proceeds in its separately owned composition/export work package and remains pending Minu review.

## Handoff notes
Create a job from an approved script revision that already points at an owned config/prompt snapshot pair. Image output is required. Video is dispatched only for a `video` capability. Narration and dialogue are dispatched only when the scene has text and a published character voice. Export returns schema `1.0` only when every active scene output is bound to published, non-empty, checksummed media. Successful outputs are copied forward on retry and replace.

## Reviewer decision
- **INTEGRATED:** Minu, PR #17 squash merge `589d28c86feaede46f516bf27555f02802882610`, with technical approval at `99b1972191038f5e4f839892bbbb196e554d6215`. (The official self-approval restriction was documented on the PR.)

## C3 follow-up — PR #97, 2026-11-13

State: IMPLEMENTED_PENDING_REVIEW for this follow-up only. Refs #75.

- Fixed B1 formatting, B3 API/web composition acceptance of ASSIGNED, B4 usage vocabulary, and B5 saved assign requests through pendingMutation/Reconcile (one key per action).
- Added B2 service, PostgreSQL, web client, and mounted-browser coverage for assignment, permissions, invalid assets, concurrency/replay, usage, zero paid dispatch, export and composition.
- Changed files: scene-media service and service/integration tests; composition service and integration test; production studio, composition helper/test, API test and mounted browser/fixture.
- Exact toolchain: Node 24.22.2, pnpm 12.16.1. Merged origin/main, then `pnpm install --frozen-lockfile` passed. No new dependencies, migration changes, provider calls, ci.yml or PROJECT_STATE edits.
- `pnpm vitest run apps/api/src/modules/scene-media/scene-media.service.test.ts apps/api/src/modules/scene-media/scene-media.integration.test.ts apps/api/src/modules/composition/composition.integration.test.ts apps/web/features/production/api.test.ts apps/web/features/production/composition.test.ts`: 128 passed.
- `PLAYWRIGHT_MODULE=/workspace/work/browser/node_modules/playwright-core ESBUILD_MODULE=/workspace/work/browser/node_modules/esbuild node apps/web/features/production/verification/mounted-browser.mjs`: 28 scenarios passed, including 390/1440 assignment role/error/reconciliation cases.
- `pnpm lint`, `pnpm format:check`, `pnpm security:secrets`, `pnpm db:check-migrations`, `pnpm db:migrate:deploy`: passed against disposable PostgreSQL 18.6 on 55437.
- Full typecheck/test/build results will be recorded below after completion. Next action: verify hosted CI on the pushed head and request Minu review; never merge.
- Full `pnpm typecheck`: passed. Full `DATABASE_URL=postgresql://postgres:postgres@localhost:55437/reelforge pnpm test`: 98 files passed, 2 skipped; 779 tests passed, 8 skipped. `NEXT_TELEMETRY_DISABLED=1 pnpm build`: passed. Hosted CI on 01ce9bd passed all checks. Final follow-up strengthens PostgreSQL coverage to prove VIDEO reuse alongside IMAGE assignment; verify hosted CI on the new head.

## Workstream C integration closeout — 2026-11-13 (#80)

C3 scene asset assignment; ASSIGNED export/composition compatibility and stable action keys landed via [PR #97](https://github.com/imTusharsingh/reelforge/pull/97), reviewed head `8979e25df4a5657cad371b69bcbc9f119d678565`, main merge `3b393023cb36ff5f2a2741f1bbb558c3a16b049a`. Earlier follow-up pending-review text is historical; no new implementation approval or live verification is claimed. Cross-flow E2E remains #79.
