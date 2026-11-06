# M05 Status - Configuration & Prompt Engine

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Module Implementation Agent
- **Branch/worktree:** `work/m05-configuration-and-prompt-engine`
- **Last updated:** 2026-11-06
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** none
- **Completion estimate:** implementation complete pending Core Architect/Reviewer validation.

## Current objective
Resolve hierarchical configuration and compile versioned prompts deterministically.

## Session start (scope summary)

- **Repo root / base:** `/home/tracxn-lp-784/Desktop/project/reelforge`, branch created from verified `origin/main` at
  `fffb1dd721494c5a4b24cc34d08500e941cc1f59` (M04 closeout; product M04 merge
  `c0a408d9572011c3b0d66e6b6704d722477dc275` is an ancestor).
- **Dependencies verified present:** M01 auth guard/workspace membership, M02 channel +
  `ChannelConfigSnapshot`/`activeSnapshotId`, M03 genre/series with opaque `promptRefs` and
  `characterGroupRefs`, M04 published `CharacterVersion`/reference packages, and the empty
  `packages/config-engine` stub. No M03/M04 stop condition found.
- **Planned tasks:** M05-T01 through M05-T07 (typed layer schemas/defaults, deterministic
  precedence merge, protected locks, workspace prompt-template version chain, deterministic
  compile with append-only user additions, immutable config/prompt snapshots, pure preview).
- **Likely own files:** `packages/config-engine/**`, `apps/api/src/modules/config/**`,
  module-local tests, this STATUS, append-only `docs/WORK_LOG.md`.
- **Likely additive shared files:** one new Prisma migration plus additive models/fields in
  `packages/database/prisma/schema.prisma` (workspace config snapshots, prompt templates/versions,
  generation config snapshots, prompt bundle snapshots); `packages/config-engine/package.json`
  and `apps/api/package.json` workspace dependency entries plus the resulting `pnpm-lock.yaml`.
  No contracts package change is currently planned.
- **Conflicts/unknowns:** none identified yet. The post-M04 Prisma Client / Nest ESM compiled-dist
  follow-up is known and is out of scope. No live provider calls will be made.

## Task checklist
- [x] M05-T01: T01 Define typed configuration schemas and defaults for each supported module.
- [x] M05-T02: T02 Implement precedence and merge rules: platform, workspace, channel, genre, series, character, video override.
- [x] M05-T03: T03 Implement locked fields and protected system/platform/safety rules.
- [x] M05-T04: T04 Implement prompt template CRUD, versioning, activation, rollback, and variables.
- [x] M05-T05: T05 Compile prompt bundles from resolved configuration and user additions.
- [x] M05-T06: T06 Persist immutable config and prompt snapshots against every generation job.
- [x] M05-T07: T07 Add a prompt preview/validation interface without executing an AI call.

## Files changed
- `apps/api/src/modules/config/**` (configuration and prompt API, services, validation, and tests)
- `packages/config-engine/src/**` (schemas, resolver, deterministic prompt compiler, utilities, and tests)
- `packages/database/prisma/schema.prisma` (additive M05 persistence models and relations)
- `packages/database/prisma/migrations/20261106130000_configuration_and_prompt_engine/migration.sql`
- `apps/api/package.json`, `packages/config-engine/package.json`, `packages/config-engine/tsconfig.json`, `packages/config-engine/src/index.ts`, `packages/config-engine/src/**`, `pnpm-lock.yaml`
- `apps/api/src/app.module.ts`
- `vitest.config.ts` (shared test resolution alias required because CI tests run before builds)
- `work-packages/M05-configuration-and-prompt-engine/STATUS.md`

## Commands and evidence
- `git fetch origin --prune` — completed.
- `git rev-parse HEAD` — `fffb1dd721494c5a4b24cc34d08500e941cc1f59`.
- `git checkout -b work/m05-configuration-and-prompt-engine origin/main` — completed.
- `pnpm install --frozen-lockfile` (Node 24.16.0) — failed with `ERR_PNPM_UNSUPPORTED_ENGINE`
  because the repo pins Node 24.22.2.
- `pnpm install --frozen-lockfile --config.engine-strict=false` (Node 24.16.0) — **PASSED** — lockfile up to date.
- `pnpm --filter @reelforge/config-engine build` — **PASSED**.
- `pnpm exec vitest run packages/config-engine/src apps/api/src/modules/config` — **PASSED** — 5 files / 40 tests.
- `pnpm format:check` — **PASSED** — all files use Prettier style.
- `pnpm typecheck` with disposable local PostgreSQL URL — **PASSED** — all workspaces.
- `pnpm lint` — **PASSED**.
- `pnpm test` — **PASSED** — 17 files / 88 tests.
- `DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/reelforge?schema=public' pnpm build` — **PASSED** — all workspace builds.
- `DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/reelforge?schema=public' pnpm db:validate` — **PASSED** — Prisma schema valid.
- `git diff --check` — **PASSED**.

## Contract/schema proposals
- Additive Prisma schema/migration for M05-owned persistence: workspace config snapshots/pointer,
  prompt template/version chain, generation config snapshots, and compiled prompt bundle snapshots.
- No `packages/contracts` change.

## Reviewer-requested contract notes

- Preview returns the complete resolved configuration alongside hashes, layers, locks, template
  metadata, and the compiled bundle.
- Capture writes the generation configuration snapshot and prompt bundle snapshot in one database
  transaction. Downstream jobs must persist both `configSnapshotId` and `promptBundleSnapshotId`,
  retrieve them through workspace-scoped getters, and consume the frozen bundle/template-version
  references even after later activation or rollback.
- Prompt versions are retained indefinitely once referenced; there is no destructive delete route.
  Future cleanup must use an explicit archive/retention policy that preserves referenced history.

## Blockers / risks / unknowns
- Snapshot capture is atomic at the database transaction boundary; concurrent version allocation
  returns a conflict for retry and does not leave a partial capture.
- The generation handoff remains an API contract until a future workflow-job module owns the
  `WorkflowRun` relation.

## Next exact action
Core Architect/Reviewer should validate the acceptance criteria, schema/API boundaries, and test
evidence; no approval or integration is claimed by this session.

## Handoff notes
Implementation complete and pending Core Architect/Reviewer validation; no approval or integration is claimed.

## Reviewer decision
- Pending.
