# M24 backend planning contract — Core fix

**Branch:** `fix/m24-planning-api-contract`  
**Consumer:** M24 Ideas, Scripts & Storyboard Workspace  
**Date:** 2026-11-11

## Why this is a separate Core change

M06 originally supported list/create/approve/reject/schedule but not editing or archiving ideas. M07 exposed script generation, fetch by ID, revision creation and approval but not script discovery or historical versions. A frontend must not invent persistence, script histories, or statuses.

This change is a backend prerequisite for M24. It does not implement M24 UI, modify shared frontend navigation, dispatch AI/provider requests, or alter existing approved snapshots.

## Added routes

All routes require the existing authenticated workspace context and enforce workspace tenant scoping.

| Method | Route (relative to `/api/v1/workspaces/:workspaceId`) | Purpose |
| --- | --- | --- |
| PATCH | `/ideas/:ideaId` | Replace editable idea brief |
| DELETE | `/ideas/:ideaId` | Archive eligible unapproved idea, not physical deletion |
| POST | `/ideas/:ideaId/restore` | Restore archived idea |
| GET | `/ideas?status=&includeArchived=true` | Filter status and optionally include archived ideas |
| GET | `/scripts?page=1` | Paged script listing with latest revision |
| GET | `/scripts/:scriptId/revisions?page=1` | Paged persisted revision history |

The existing `GET /ideas` defaults to active (non-archived) ideas. `includeArchived=true` includes both archived and active records; filter archived results using the returned `archivedAt`.

### Idea mutation payloads

`PATCH /ideas/:ideaId` accepts all existing M06 `ideaSchema` fields, plus the mandatory server-issued `expectedUpdatedAt` ISO timestamp. The existing `channelId` / `seriesId` ownership and consistency rules apply.

`DELETE /ideas/:ideaId` and `POST /ideas/:ideaId/restore` accept JSON:

```json
{"expectedUpdatedAt":"2026-11-11T10:00:00.000Z"}
```

All these writes return the persisted idea. A concurrent edit/archive or stale timestamp returns HTTP 409; clients must refresh, compare and explicitly resubmit. The server never silently overwrites a newer version.

**Permissions:** `OWNER` and `EDITOR` may mutate. `VIEWER` can read but not mutate. Non-members cannot access another workspace's data. Draft, backlog and rejected ideas can be edited/archived only if there has **never** been an approval snapshot. Approved, scheduled or historically approved records are protected. Archiving retains data and status; restored ideas return to their original state. It is not implemented as `REJECTED`.

### Script pages

The list and history endpoints return `{ "items": [...], "nextPage": null | number }`; pages are 1-indexed, 50 entries each, with a stable descending sort. `GET /scripts` includes only the latest revision per script. `GET /scripts/:scriptId/revisions` contains the persisted revision document and safe provenance (model/prompt version), **not dispatched prompt text** or secret provider material. This is real stored history, not reconstructed or AI-generated history. Existing script `GET` and mutation APIs are unchanged.

### Database change

Additive `ideas.archived_at TIMESTAMPTZ(6) NULL` plus a workspace/archive index. Previous rows remain active; existing idea status values and approval snapshots are preserved. Migration: `20261119010000_m24_idea_archive`. Migrations must be applied before deploying server code using `archivedAt`. Prisma client generation is required in the normal build process.

### Verification and release gates

Regression tests: `idea.planning-contract.test.ts` and `script.planning-contract.test.ts`. Before merge, run exact-head CI including typecheck, formatting, lint, database validation, schema migration guard, unit/integration tests. Verify HTTP role/tenant tests against a migrated PostgreSQL fixture. **No live provider calls**.

No command in the connected GitHub editing session is claimed as passed without a visible CI outcome. Review and merge should follow Core approval rules.

### M24 implementation handoff

M24 should consume these new endpoints, use `updatedAt` for optimistic concurrency, expose genuine archives, real script lists and revision history, and use existing M07 `POST /scripts/:scriptId/revisions` for scene-level edits. Script generation remains subject to approved idea checksum, config/prompt snapshots, provider readiness and budgets.
