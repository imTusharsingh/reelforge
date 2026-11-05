# M03 Status - Genres, Formats & Content Series

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Module implementation session
- **Branch/worktree:** `work/m03-genres-formats-and-content-series`
- **Last updated:** 2026-11-05
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** none

## Current objective
Provide configurable genre templates and recurring content series without hardcoded niche logic.

## Task checklist
- [x] M03-T01: Genre template model and deterministic starter catalog.
- [x] M03-T02: Workspace-scoped custom genre CRUD and clone-from-template.
- [x] M03-T03: Structured genre policy fields.
- [x] M03-T04: Channel-scoped content-series list/create/update.
- [x] M03-T05: Series format, frequency, character-group refs, and prompt refs.
- [x] M03-T06: Workspace/channel/genre validation with actionable errors.


## Files changed
- `apps/api/src/modules/genre/**`: authenticated templates, genre, and series API.
- `apps/api/src/app.module.ts`: module registration.
- `packages/database/prisma/schema.prisma`: additive GenreTemplate, Genre, and ContentSeries fields.
- `packages/database/prisma/migrations/20261106110000_genres_and_series/migration.sql`: additive schema and starter catalog migration.
- `apps/api/src/modules/genre/genre.service.test.ts`: cross-workspace boundary tests.

## Commands and evidence
- `DATABASE_URL='postgresql://reelforge:reelforge@localhost:5432/reelforge' pnpm db:generate`: passed.
- Same `pnpm typecheck`: passed for all packages.
- `pnpm lint`: passed.
- `pnpm test`: passed, 6 files / 18 tests.
- `pnpm format:check`: passed.
- Same `pnpm db:validate`: passed.
- `pnpm db:migrate:deploy`: not run; local PostgreSQL credentials were not available. Migration SQL should be exercised by CI/Core review.

## Contract/schema proposals
- Additive schema change requested: `GenreTemplate`, workspace-scoped `Genre`, and required ContentSeries genre/format/frequency/reference fields. No contracts package change.

## Blockers / risks / unknowns
- Migration deployment against a live local PostgreSQL instance remains unverified.
- Series character and prompt references are intentionally opaque JSON IDs/keys; M04/M05 own their entities and semantics.
- API tests use local database seams only; no live provider calls.

## Scope summary before implementation

- Implement M03 genre templates/catalog, workspace-scoped custom genre CRUD and cloning, and channel-scoped content-series CRUD.
- Extend the existing `ContentSeries` model additively with genre, format, frequency, character-group references, and prompt references.
- Reuse M01 authentication/workspace context and M02 channel composite scoping; add runtime validation and cross-workspace/channel tests.
- Likely files: `apps/api/src/modules/genre/**`, `apps/api/src/app.module.ts`, Prisma schema plus a new M03 migration, and module status/work log.
- No conflicts found: `main` is at M02 closeout `a032fe1c40566f20b46b721d6fe012f69e7c3dad`; no existing genre/series API module is present. Shared schema edits are additive and explicitly authorized by the assigned brief.

## Next exact action
Core Reviewer should inspect the additive migration, run migration deployment in ephemeral PostgreSQL, and review API authorization/validation before owner merge.

## Handoff notes
No implementation session has started.

## Reviewer decision
- Pending.
