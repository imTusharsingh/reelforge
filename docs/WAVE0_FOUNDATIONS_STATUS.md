# M00 Wave 0 foundations / PR B handoff

State: IMPLEMENTED_PENDING_REVIEW. Owner assignment: the pasted LOCKED v2.0 Wave 0 plan, 2026-11-16, explicitly includes shared contracts, one migration and root tooling. This record does not claim approval or integration. Depends on decision PR #110 (ADR-026–028); both branches start from main bb39fc3.

Implemented: versioned contracts and additive persistence; ADR-003 guarded delegates for all eleven new tables; immutable reference/brief/shot/event versions; one offline, transaction-locked idempotent seed used by migration, API boot and workspace creation; compatibility script prompt/config/genre/budget defaults; channel narrator; 24 fps normalization; informational background recovery; script copy limits; retired OpenAI video removal; explicit configurable text fallback; off-by-default pipeline.v2; deprecation inventory and markers; local quality scripts and baselines. No V2–V10 adapter, agent, orchestrator or replacement UI implementation, no bug-6 change, and no ci.yml or PROJECT_STATE edits.

The seed registers nine prompt roles: planner, researcher, scriptwriter, storyboard, director, narrator, critic, publisher and analyst. The Cursor canvas returned a browser challenge; this role inventory and the inferred requirement allocations in DEPRECATIONS.md need comparison with the canvas during Minu review. All deprecation concerns explicitly enumerated in the owner assignment are covered. No external capability or live-provider verification is claimed.

Friday bugs:

1. Fresh workspace: real HTTP registration/workspace/channel/idea/approval/script generation with a stub provider, no manual database setup; the seeded snapshots and fallback workspace budget make M07 usable.
2. MISSING_VOICE: channel-level provider/voice/language, optional characters; narrator-only voice regression passes.
3. M10: 1024×1536, 720×1280 and 1080×1920 PNGs render via real FFmpeg to 1080×1920 H.264 at 24 fps. Final media remains validated. Fade durations may round by up to one output frame.
4. Interrupted save: automatic background reconciliation and informational banner, explicit retry works without dismissal; concurrent active writes remain blocked.
5. Hook 1–20 words, CTA 1–15 words, total spoken text bounded at 210 words/minute; malformed supplied copy is rejected before text dispatch and invalid persisted/provider-generated script copy is rejected before any media dispatch. Text generation necessarily precedes validation of its generated response; no claim that an unknown generated result can be validated before it exists.

Contracts/schema: ChannelBrief, VideoRun, VideoRunStep, ShotSpec, ProviderCapability, RunEvent, BudgetEnvelope, ReferenceAsset, ChannelReferenceDefaults; WorkspaceFoundationDefaults and FormatTemplate hold offline defaults. Every new table includes workspace_id and a workspace FK; child relations use compound tenant keys. Consumers use foundationWorkspaceGuard with verified WorkspaceService context, never raw client access. ReferenceAsset uses immutable version rows over M04 assets/character versions. Legacy data is not dropped.

Validation before final full suite:

- Pinned Node 24.22.2 / pnpm 12.16.1; frozen dependency install passed.
- Strict lint passed with zero warnings; workspace typecheck passed.
- Focused source coverage: 56 files / 458 tests passed; changed code preview 89.73% lines, 85.81% branches.
- Acceptance focus: 5 files / 27 tests passed including PostgreSQL and real FFmpeg; recovery DOM: 3 tests passed; legacy regression focus: 106 tests passed.
- Fresh PostgreSQL 18 migration chain applied. Populated main-to-Wave-0 upgrade applied, with 8 formats / 9 prompt templates and an existing $99/day budget preserved. Repeat seed passed unchanged-record checks, and seeded bundle fingerprints match M05 compilation.
- Knip: clean against baseline (122 existing findings, 5 resolved).
- Production build / final full suite / final coverage: results appended below after execution. Redis integration may be skipped if REDIS_URL is unavailable; no paid/provider tests are run live.

Next: official Minu review of the exact PR heads, including SQL/contract ownership and canvas comparison. Squash merge only after that review; implementer does not merge. V3 owns asynchronous HTTP/orchestration work; V8 owns UI cutover; T2 owns old-flow retirement with ADRs/migrations for data removal.

Changed files (plus this handoff and appended status/work-log records):

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
- `apps/api/src/modules/script/script.module.ts`
- `apps/api/src/modules/script/script.service.ts`
- `apps/api/src/modules/script/script.validation.ts`
- `apps/api/src/modules/workspace/workspace.service.test.ts`
- `apps/api/src/modules/workspace/workspace.service.ts`
- `apps/web/app/planning/page.tsx`
- `apps/web/app/production/page.tsx`
- `apps/web/app/review/page.tsx`
- `apps/web/features/channels/configuration-panel.tsx`
- `apps/web/features/planning/model.test.ts`
- `apps/web/features/planning/model.ts`
- `apps/web/features/planning/recovery.test.ts`
- `apps/web/features/planning/session.tsx`
- `apps/web/features/production/api.ts`
- `apps/web/features/production/composition.ts`
- `docs/QUALITY_GATES.md`
- `eslint-size-baseline.json`
- `eslint.config.js`
- `knip-baseline.json`
- `knip.json`
- `package.json`
- `packages/config-engine/src/config.schema.ts`
- `packages/config-engine/src/feature-flags.test.ts`
- `packages/config-engine/src/feature-flags.ts`
- `packages/config-engine/src/index.ts`
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


Final verification (2026-11-16):

- `pnpm test:coverage:changed` after the final seed provenance correction: PASS, 127 files / 952 tests; 1 file / 3 Redis tests skipped because REDIS_URL is unset. v8 changed-code coverage: 93.15% lines (136/146), 89.26% branches (133/149), above 80%/70%. Whole included-file coverage: 82.22% lines, 73.93% branches. The earlier full run also passed; final review then corrected the seeded M05 resolution hash and lock ordering, added an exact resolver comparison and repeated final validation. No application changes followed the final run.
- `pnpm build` with `NEXT_TELEMETRY_DISABLED=1`: PASS. `pnpm typecheck`: PASS. `pnpm lint` with `--max-warnings=0`: PASS. `pnpm exec prettier --check .`: PASS.
- `pnpm knip`: PASS, 122 existing baseline findings / 5 resolved; no new unused-code findings.
- `pnpm db:validate`: PASS. `pnpm db:check-migrations`: PASS, 34 ordered migrations; original migrations unchanged. `pnpm security:secrets`: PASS. `git diff --check origin/main`: PASS.
- Final SQL applied to a new PostgreSQL 18 database. The final populated-upgrade test applied main's chain, inserted an existing workspace with a custom $99/day budget, then applied Wave 0: 8 formats and 9 prompt templates seeded, $99/day preserved, repeat seed unchanged. The HTTP test verifies seeded prompt fingerprints and config resolution hashes against the M05 compiler/resolver.
- No live AI/social calls. Existing negative-path tests emit expected service-error diagnostics; pg also emits an inherited concurrent-query deprecation warning. Strict lint/typecheck produce zero warnings. No Redis server or Playwright browser E2E was run; the fresh-install E2E is a real Nest/PostgreSQL HTTP test with an injected stub provider.

The final branch was checked against origin/main bb39fc3 by fetch and merge (already up to date). Commits and PR are authored as imTusharsingh. Both PRs remain unmerged pending official Minu review.
