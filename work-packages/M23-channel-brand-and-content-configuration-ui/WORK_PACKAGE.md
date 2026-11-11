# M23 - Channel, Brand & Content Configuration UI

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m23-short-description`  
**Dependencies:** M02-M05, M21-M22.

## Objective

Build channel list/detail/create/edit/archive; brand identity; genre/niche and format management; series; characters/personas and assets; content preferences; M05 configuration visibility; validation, preview, search and filters.

## Scope owned by this block

Build channel list/detail/create/edit/archive; brand identity; genre/niche and format management; series; characters/personas and assets; content preferences; M05 configuration visibility; validation, preview, search and filters.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's owned files without written Core Architect/Reviewer approval.
- Claiming provider/platform capabilities that are not configured and verified.



## Tasks

- [ ] **M23-T01:** Build channel list/detail/create/edit/archive
- [ ] **M23-T02:** brand identity
- [ ] **M23-T03:** genre/niche and format management
- [ ] **M23-T04:** series
- [ ] **M23-T05:** characters/personas and assets
- [ ] **M23-T06:** content preferences
- [ ] **M23-T07:** M05 configuration visibility
- [ ] **M23-T08:** validation, preview, search and filters.

## Public interface / output contract

Channel management; brand editor; genre/series/character management; content configuration screens.

## Acceptance criteria

All changes use existing backend contracts and permissions; configuration affects downstream workflows.

## Files owned (proposed)

- `apps/web/**` for frontend work, following the repository's approved Next.js structure.
- `docs/**` for module-owned design/product/operational documentation.
- Module-local tests and fixtures.
- Backend/API changes only when explicitly assigned and approved; prefer existing M00-M20 contracts.

Inspect current paths before editing. Do not create alternate patterns without approval.

## Shared-file restrictions

Do not edit root configs, `packages/contracts/**`, `packages/database/prisma/schema.prisma`, migration ordering, root route registry, or another module's owned files without written approval. Submit a contract/schema proposal when needed.

## Required test evidence

List exact commands run and actual pass/fail results in `STATUS.md`. Never claim a command passed unless executed. Tests must not make live provider calls. Live verification requires explicit owner authorization.

## Required handoff

Update `STATUS.md` with state/estimate, files changed, completed/remaining tasks, commands/results, contract/schema proposals, defects/risks/blockers, next action, and decisions requiring approval.

## Done means

The module is `IMPLEMENTED_PENDING_REVIEW`, not `APPROVED`, until the Core Architect/Reviewer verifies scope, acceptance criteria, tests, security, boundaries and integration compatibility.
