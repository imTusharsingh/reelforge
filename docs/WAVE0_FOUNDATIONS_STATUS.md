# M00 / V1 foundations — PR #111 review handoff

State: IMPLEMENTED_PENDING_REVIEW. Source of truth: [issue #112](https://github.com/imTusharsingh/reelforge/issues/112), body and both comments, including the Page v2.0 export and final fix prompt. Read and verified against that source. This follow-up addresses official Minu review 5916107268. Docs PR #110 (corrected head ef34d69) received official Minu approval and was squash-merged externally as cd39f30. This branch now includes it through a merge of origin/main, resolving the documentation prerequisite. No approval, integration or merge claimed.

## Review disposition

- B1: exact fourteen run states and exported VIDEO_RUN_TRANSITIONS with exact-edge/terminal tests; step attempt states unchanged. All new persisted entities now carry schemaVersion; run brief version and step cost/artifacts are persisted as specified in A1.
- B2: ShotSpec keyframe/motion prompts, VO line, on-screen text, continuity notes, pinned first-frame source (earlier ordinal or reference pin), 3–10-second shot duration, 9:16 dimensions and up to six planned references.
- B3: MUSIC; aspects/ref count/first-last-frame/extension/native audio/health; nullable prices by 360p/720p/1080p in integer micro-USD per second (69504 represents $0.069504/s, 140000 represents $0.14/s). Model IDs remain supplied by config; no adapter built.
- B4: niche/topic, style bible, language triplet, narrator pace and optional on-camera voice, guardrails, format mix and explicit nullable tuning bounds for mix/scoring weights, reference defaults and extension constraints. Missing tuning bounds mean recommendations only.
- B5: baseEstimateMinor, reshootReserveMinor and PRIMARY/FALLBACK route in contracts/Prisma/SQL; the database rejects base + reserve above the hard cap. Tests include primary reserve overflow and fallback without reserve.
- B6: count approved Shorts per channel, preserve L1/L2, downgrade only requested L3 before ten approvals; rename approvedShortsAtStart in contract/Prisma/SQL.
- B7: seven exact role keys: v1.trend-scout, v1.idea-scorer, v1.scriptwriter, v1.director, v1.art-director, v1.critic, v1.packager. Defaults and repeat-seed tests assert the exact inventory; HTTP E2E selects the scriptwriter bundle by template key.
- B8: DEPRECATIONS.md and markers match the Page list. M03 required-choice guard is removed: owned genre lookup is case-insensitive, with the seeded Explainer as fallback. Missing/blank document genre defaults to Explainer. M05 setup is removed by V1 seed; M07 code V4/columns T2; M09 sync/stills V5; M11 V6; old config V7; manual ideas and pipeline.v2 rows included with T2 removal.

## Friday bugs 1–5

1. Fresh install: real registration → workspace → channel → idea/approval → script HTTP E2E with PostgreSQL and a stub provider, no manual DB setup. Unknown genre is accepted through the default fallback.
2. Narrator-only voice: channel provider/voice/language; characters optional. Existing voice regression retained.
3. Render input sizes: 1024×1536, 720×1280 and 1080×1920 normalize to 1080×1920 at 24 fps/H.264 with real FFmpeg. Final output validation remains strict; fade duration allows at most one frame of rounding.
4. Background reconciliation stays informational. Script requests journal only a content fingerprint and correlation ID, retained across acknowledgement and page reload until a valid success response. Explicit retry reuses that ID; real API replay returns a non-dispatch conflict at M18, and the stub provider is not called a second time. No prompt bodies or keys are stored. Planning types/parsers/edit helpers/pending state were split into modules under 400 lines; existing tests were preserved in smaller suites.
5. Hook 1–20 words, CTA 1–15 words and duration word budget: supplied invalid copy is rejected before text dispatch; invalid generated/persisted script copy is rejected before media dispatch. A text response can only be validated after generation. No live provider calls.

## Scope and notes

Exactly one unmerged migration, 20261123010000_wave0_foundations, edited in place as directed. No existing main migration, table or column removed. Local developers who applied the previous unmerged draft must recreate their disposable development database; no production application of that draft is assumed.

No V2–V10 adapters, orchestrator, agents or replacement UI. No bug-6 change, ci.yml or PROJECT_STATE edits, forbidden local files, secrets, force-push or rebase.

Non-blocking follow-ups are explicit in DEPRECATIONS.md: split the legacy scene-media service with V5 deletion; V4 templates the legacy Explainer/30-second prompt example from format/Brief; V7 resolves the workspace CHANNEL timezone sentinel to an IANA channel timezone before CadenceSchema validation; U1 decides shared preset catalog versus per-workspace copies in its ADR. Dedicated bootstrap-provider separation is a considered later refactor; current boot seeding remains offline, locked and idempotent. OpenAI text fallback requires both a key and OPENAI_TEXT_FALLBACK_ENABLED=true until V2 supplies the primary text adapter; a key alone does not enable it.

The Knip baseline is pruned only after the existing check passes; no added findings are accepted. Strict size/lint/typecheck gates apply, with the pre-existing size baseline retained for untouched legacy assemblies and the explicitly deferred scene-media split.

## Verification

Focused contracts/retry/genre/DB checks passed before final validation. A focused changed-code preview cleared the floors at 89.05% lines / 81.86% branches. Exact final commands/counts and migration/upgrade evidence are recorded below after execution; unrun checks are not claimed.

Next: official Minu review of the exact head and the edited SQL; the #110 prerequisite is integrated; #111 remains eligible only for squash integration after its own official approval. Implementer does not merge.

## Changed files

- `.env.example`
- `.gitignore`
- `DEPRECATIONS.md`
- `apps/api/src/modules/channel/channel.service.ts`
- `apps/api/src/modules/channel/channel.types.ts`
- `apps/api/src/modules/composition/composition.controller.ts`
- `apps/api/src/modules/composition/composition.engine.integration.test.ts`
- `apps/api/src/modules/composition/composition.engine.ts`
- `apps/api/src/modules/composition/composition.integration.test.ts`
- `apps/api/src/modules/composition/composition.validation.ts`
- `apps/api/src/modules/config/config.controller.ts`
- `apps/api/src/modules/config/prompt.controller.ts`
- `apps/api/src/modules/genre/genre.module.ts`
- `apps/api/src/modules/idea/idea.controller.ts`
- `apps/api/src/modules/idea/idea.module.ts`
- `apps/api/src/modules/identity/identity.module.ts`
- `apps/api/src/modules/openai/openai.adapters.test.ts`
- `apps/api/src/modules/openai/openai.adapters.ts`
- `apps/api/src/modules/orchestration/orchestration.module.ts`
- `apps/api/src/modules/performance-intelligence/performance-intelligence.module.ts`
- `apps/api/src/modules/quality/quality.module.ts`
- `apps/api/src/modules/scene-media/scene-media.controller.ts`
- `apps/api/src/modules/scene-media/scene-media.module.ts`
- `apps/api/src/modules/scene-media/scene-media.service.test.ts`
- `apps/api/src/modules/scene-media/scene-media.service.ts`
- `apps/api/src/modules/scene-media/scene-media.types.ts`
- `apps/api/src/modules/script/foundations.http.integration.test.ts`
- `apps/api/src/modules/script/script-genre.test.ts`
- `apps/api/src/modules/script/script-genre.ts`
- `apps/api/src/modules/script/script.module.ts`
- `apps/api/src/modules/script/script.service.ts`
- `apps/api/src/modules/script/script.types.ts`
- `apps/api/src/modules/script/script.validation.ts`
- `apps/api/src/modules/workspace/workspace.service.test.ts`
- `apps/api/src/modules/workspace/workspace.service.ts`
- `apps/web/app/planning/page.tsx`
- `apps/web/app/production/page.tsx`
- `apps/web/app/review/page.tsx`
- `apps/web/features/channels/configuration-panel.tsx`
- `apps/web/features/planning/model-edit.ts`
- `apps/web/features/planning/model-parse.ts`
- `apps/web/features/planning/model-pending.ts`
- `apps/web/features/planning/model-types.ts`
- `apps/web/features/planning/model.test.ts`
- `apps/web/features/planning/model.ts`
- `apps/web/features/planning/pending-save.test.ts`
- `apps/web/features/planning/recovery.test.ts`
- `apps/web/features/planning/script-request.test.ts`
- `apps/web/features/planning/script-request.ts`
- `apps/web/features/planning/script-retry.test.ts`
- `apps/web/features/planning/session.tsx`
- `apps/web/features/production/api.ts`
- `apps/web/features/production/composition.ts`
- `docs/QUALITY_GATES.md`
- `docs/WAVE0_FOUNDATIONS_STATUS.md`
- `docs/WORK_LOG.md`
- `eslint-size-baseline.json`
- `eslint.config.js`
- `knip-baseline.json`
- `knip.json`
- `package.json`
- `packages/config-engine/src/config.schema.ts`
- `packages/config-engine/src/feature-flags.test.ts`
- `packages/config-engine/src/feature-flags.ts`
- `packages/config-engine/src/index.ts`
- `packages/contracts/src/foundations-review.test.ts`
- `packages/contracts/src/foundations.test.ts`
- `packages/contracts/src/foundations.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/script-content.ts`
- `packages/database/prisma/migrations/20261123010000_wave0_foundations/migration.sql`
- `packages/database/prisma/schema.prisma`
- `packages/database/src/foundation-workspace.test.ts`
- `packages/database/src/foundation-workspace.ts`
- `packages/database/src/foundations-1.integration.test.ts`
- `packages/database/src/foundations-2.integration.test.ts`
- `packages/database/src/foundations-3.integration.test.ts`
- `packages/database/src/foundations.fixture.ts`
- `packages/database/src/index.ts`
- `packages/database/tsconfig.build.json`
- `packages/media/src/index.ts`
- `packages/media/src/media.test.ts`
- `pnpm-lock.yaml`
- `scripts/check-changed-coverage.mjs`
- `scripts/check-knip.mjs`
- `vitest.config.ts`
- `work-packages/M00-repository-governance-and-shared-contracts/STATUS.md`


## Final verification after merging main

- `pnpm test:coverage:changed` with disposable PostgreSQL and real FFmpeg: PASS, 132 files / 966 tests passed; one Redis file / three tests skipped (REDIS_URL unavailable). v8 changed-code coverage: **90.53% lines (306/338), 83.02% branches (357/430)**, above 80%/70%. Whole included-file coverage: 83.03% lines / 74.40% branches. Full suite run once after all review fixes and the main merge, immediately before final documentation recording and push; no application changes afterward.
- `pnpm lint` (`--max-warnings=0`), `pnpm typecheck`, `pnpm build` with NEXT_TELEMETRY_DISABLED=1, `pnpm exec prettier --check .`: PASS.
- `pnpm knip`: PASS; baseline only shrank from 127 to 121 existing findings, no additions. Removed an unused parseScene export while splitting the planning module.
- `pnpm db:validate`, `pnpm db:check-migrations` (34 ordered migrations), `pnpm security:secrets`, `git diff --check origin/main`: PASS. No original main migration changed.
- Final migration applied to a new PostgreSQL database. Populated main-to-final-draft upgrade: PASS, eight formats / seven exact prompt roles, an existing $99/day provider budget preserved, repeated seed unchanged. HTTP E2E checks M05 compiler/resolver fingerprints and scriptwriter selection by key; database tests check exact roles, state/version/cost/artifact columns, overflow/fallback envelope constraints and every new table's tenant guard.
- Paid retry regressions: client identity survives background acknowledgement and reload, only one paid identity; real API/M18 rejects repeat correlation without a second provider invocation.
- Expected negative-path service diagnostics and an inherited pg concurrent-query deprecation appear during tests; strict lint/typecheck have zero warnings. No live AI/social calls or provider acceptance claimed.

Branch includes official Minu-approved decision PR #110 through merge commit 2ad330f (main cd39f30). PR #111 remains IMPLEMENTED_PENDING_REVIEW; no implementer merge or approval.
