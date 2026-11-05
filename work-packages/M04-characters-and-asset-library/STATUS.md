# M04 Status - Characters & Asset Library

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Module Implementation Agent (this session)
- **Branch/worktree:** `work/m04-characters-and-asset-library`
- **Base commit:** `fba08da1dfc12a8a68bdd29610fd24469b514d58` (main; M03 closeout)
- **Last updated:** 2026-11-06
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** none
- **Completion estimate:** implementation and local verification complete; review pending. This is not an approval claim.

## Current objective
Maintain reusable characters and licensed media assets with versioned references.

## Scope summary

### Tasks completed
- [x] **M04-T01:** Character, character group, character version, membership, and assignment models.
- [x] **M04-T02:** Built-in starter catalog (`starter-nova`, `starter-atlas`) with project-authored CC0-1.0 PNG bytes embedded in code and rights metadata seeded in the migration.
- [x] **M04-T03:** Authenticated workspace-scoped asset upload with media-type/size/content validation, metadata, storage port, and real local filesystem adapter.
- [x] **M04-T04:** Character profile: name, description, personality, voice preference, visual invariants, variation rules.
- [x] **M04-T05:** Group membership pinning a published character version; channel/series assignment with exactly-one-target validation and workspace scoping.
- [x] **M04-T06:** Asset version chain, SHA-256 checksum, license/rights metadata, and automatic `CHARACTER_VERSION` usage references on publish.
- [x] **M04-T07:** Read-only immutable reference packages for characters and character groups, returning exact pinned asset versions and checksums.

### API surface added (all under `/api/v1`, authenticated)
- `GET/POST /workspaces/:workspaceId/assets`
- `GET /workspaces/:workspaceId/assets/:assetId`
- `GET /workspaces/:workspaceId/assets/:assetId/versions`
- `POST /workspaces/:workspaceId/assets/:assetId/versions`
- `GET /workspaces/:workspaceId/assets/:assetId/usage`
- `POST /workspaces/:workspaceId/assets/references/resolve`
- `GET /workspaces/:workspaceId/character-templates`
- `GET/POST /workspaces/:workspaceId/characters`
- `GET/PATCH /workspaces/:workspaceId/characters/:characterId`
- `POST /workspaces/:workspaceId/characters/:characterId/publish`
- `POST /workspaces/:workspaceId/characters/:characterId/archive`
- `GET /workspaces/:workspaceId/characters/:characterId/versions[/:version]`
- `GET /workspaces/:workspaceId/characters/:characterId/reference-package?version=`
- `GET/POST /workspaces/:workspaceId/character-groups`
- `GET/PATCH /workspaces/:workspaceId/character-groups/:groupId`
- `POST/DELETE /workspaces/:workspaceId/character-groups/:groupId/members[/:characterId]`
- `POST/DELETE /workspaces/:workspaceId/character-groups/:groupId/assignments[/:assignmentId]`
- `GET /workspaces/:workspaceId/character-groups/:groupId/reference-package`

Uploads use canonical base64 JSON (`contentBase64`, `mediaType`, `filename`, `rights`) to avoid adding a multipart dependency. The JSON body limit is raised to 40 MB; the default asset limit is 25 MiB (`ASSET_MAX_BYTES`).

### Dependencies / baselines reused
- M01 `AuthGuard`, workspace membership `WorkspaceService.context`, `@Inject("DATABASE")`.
- M02/M03 workspace scoping and channel/series records.
- M03 `characterGroupRefs` remain opaque JSON IDs; M04 does not rewrite M03 CRUD or auto-sync assignments into that JSON.

## Files changed

### Schema and migration
- `packages/database/prisma/schema.prisma` (additive enums/models/fields only)
- `packages/database/prisma/migrations/20261106120000_characters_and_asset_library/migration.sql`

### Asset module
- `apps/api/src/modules/asset/asset.controller.ts`
- `apps/api/src/modules/asset/asset.module.ts`
- `apps/api/src/modules/asset/asset.service.ts`
- `apps/api/src/modules/asset/asset.types.ts`
- `apps/api/src/modules/asset/asset.validation.ts`
- `apps/api/src/modules/asset/storage/checksum.ts`
- `apps/api/src/modules/asset/storage/local-storage.adapter.ts`
- `apps/api/src/modules/asset/storage/storage.factory.ts`
- `apps/api/src/modules/asset/storage/storage.port.ts`
- `apps/api/src/modules/asset/asset.service.test.ts`
- `apps/api/src/modules/asset/storage/local-storage.adapter.test.ts`

### Character module
- `apps/api/src/modules/character/character.controller.ts`
- `apps/api/src/modules/character/character.module.ts`
- `apps/api/src/modules/character/character.service.ts`
- `apps/api/src/modules/character/character.types.ts`
- `apps/api/src/modules/character/character.validation.ts`
- `apps/api/src/modules/character/starter-assets.ts`
- `apps/api/src/modules/character/character.service.test.ts`
- `apps/api/src/modules/character/starter-assets.test.ts`

### Wiring and configuration
- `apps/api/src/app.module.ts` (register `AssetModule`, `CharacterModule`)
- `apps/api/src/main.ts` (40 MB JSON body limit for base64 uploads)
- `.env.example` (`STORAGE_DRIVER`, optional `STORAGE_LOCAL_ROOT`, optional `ASSET_MAX_BYTES`)
- `work-packages/M04-characters-and-asset-library/STATUS.md`
- `docs/WORK_LOG.md`

## Schema and migration notes
- New enums: `AssetOwnership`, `AssetStatus`, `CharacterStatus`, `CharacterVersionStatus`.
- Extended `Asset` with filename, size, checksum, version chain (`rootAssetId`, `supersedesAssetId`, `version`), ownership/status, license/rights metadata, creator, and update timestamp.
- Preserved `(workspaceId, id)` and `(workspaceId, objectKey)` uniqueness; added `(workspaceId, rootAssetId, version)` uniqueness.
- New models: `AssetUsageReference`, `CharacterTemplate`, `Character`, `CharacterVersion`, `CharacterGroup`, `CharacterGroupMember`, `CharacterGroupAssignment`.
- Migration backfills legacy assets with `root_asset_id = id`; they remain `PENDING` and cannot be referenced until real bytes/checksum/rights are recorded.
- Migration adds a `CHECK` constraint requiring exactly one of `channel_id` / `series_id` on group assignments.
- Migration seeds the two starter templates with documented rights. Starter PNG bytes live in `starter-assets.ts` and are written to storage when a starter character is created.
- Prior migrations were not edited.

## Commands actually run and results

All commands were run from the repository root unless noted. `DATABASE_URL` pointed at a disposable local PostgreSQL 17 container on port 55432 for database commands.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | **FAILED** — `ERR_PNPM_UNSUPPORTED_ENGINE`; repo wants Node `24.22.2`, environment has `24.16.0`. |
| `pnpm install --frozen-lockfile --config.engine-strict=false` | **PASSED** — lockfile up to date, resolution skipped. |
| `pnpm lint` | **PASSED** — no output/errors. |
| `pnpm format:check` | **PASSED** — “All matched files use Prettier code style!” |
| `pnpm typecheck` | **PASSED** — all workspaces, including API and database. |
| `pnpm test` | **PASSED** — 11 files / 42 tests. |
| `pnpm build` | **PASSED** — all workspaces, including Next.js and API TypeScript builds. |
| `pnpm db:validate` | **PASSED** — schema valid. |
| `pnpm db:migrate:deploy` | **PASSED** — 6 migrations found; new migration applied; re-run reported “No pending migrations to apply.” |
| `prisma migrate diff --from-config-datasource --to-schema ...` | M04 changes are absent from the diff; only pre-existing M02/M03 drift remains (channel active-snapshot FK name, genre ID DB defaults). Not introduced by M04. |
| Real database smoke flow via temporary Vitest test | **PASSED** — created a workspace, selected `starter-nova`, wrote real PNG bytes, published v1, recorded `CHARACTER_VERSION` usage, resolved the reference package, uploaded asset v2, and resolved v1/v2 by root ID. Temporary test was removed after running. |
| `git diff --check` | **PASSED** — no whitespace errors. |
| GitHub Actions `quality` on PR #10 | **PASSED** — both check runs completed successfully (`42102173141` / `42102234899`). |

## Contract/schema changes requested
- Additive Prisma schema and one new migration, as listed above. No `packages/contracts` change is proposed; T07 is exposed as a versioned HTTP API under `/api/v1`.
- Request review/approval for keeping the storage port module-local under `apps/api/src/modules/asset/storage/` until M10 owns `packages/media`.
- Request review/approval for the starter-asset approach: project-authored deterministic PNG bytes embedded in code, seeded template rights metadata, no downloads or live provider calls.

## Risks and known gaps
- **No production object storage adapter.** Only `STORAGE_DRIVER=local` is implemented; `STORAGE_DRIVER=s3` fails loudly. Local files are not shared across API instances. M10/deployment must add an approved S3-compatible adapter.
- **Node version mismatch in this environment.** The required `pnpm install --frozen-lockfile` command could not pass under Node 24.16.0; CI should run the pinned 24.22.2.
- **Legacy assets remain non-referenceable.** Existing `assets` rows were backfilled with a root ID but have no checksum/rights/real bytes and stay `PENDING`.
- **Base64 JSON uploads are memory-heavy.** The default 25 MiB limit and 40 MB JSON body cap may be unsuitable for large video; streaming/multipart or direct-to-object-storage upload is a future deployment concern.
- **No download URL.** Reference packages return immutable asset IDs, object keys, checksums, media types, sizes, and rights; they do not fabricate a public URL.
- **No automatic M03 sync.** M03 `characterGroupRefs` are still opaque and are not automatically updated when M04 assignments change.
- **No asset archive/delete endpoint.** `ARCHIVED` status exists in the schema but is not exposed by M04.
- **No UI.** M04 exposes the API only.

## Next exact action
Core Reviewer (Minu) should review the branch/PR against the M04 acceptance criteria, especially storage honesty, workspace scoping, immutable versioning, and the starter-asset rights approach. If changes are requested, address them on `work/m04-characters-and-asset-library`; do not merge.

## Handoff notes
- Pull request: https://github.com/imTusharsingh/reelforge/pull/10 (open, not merged; CI `quality` passed).
- Branch is based on M03 closeout `fba08da1dfc12a8a68bdd29610fd24469b514d58`.
- Do not mark APPROVED/INTEGRATED/DONE; only the reviewer/owner can do that.
- To reproduce database verification, run a disposable PostgreSQL instance and export `DATABASE_URL`, then run `pnpm db:migrate:deploy`.
- Local storage defaults to `<os tmpdir>/reelforge-storage`; set `STORAGE_LOCAL_ROOT` for a stable path.

## Reviewer decision
- Pending.
