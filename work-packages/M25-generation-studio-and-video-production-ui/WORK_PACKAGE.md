# M25 - Generation Studio & Video Production UI

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m25-short-description`  
**Dependencies:** M08-M10, M16, M18, M21, M24.

## Objective

Build generation project and scene view; image/video/voice controls only for configured providers; provider/model options only where exposed; cost/budget indicators where authoritative; progress/retry/failure; asset gallery/replacement; narration; sequence/timeline; video preview; export/download/history.

## Scope owned by this block

Build generation project and scene view; image/video/voice controls only for configured providers; provider/model options only where exposed; cost/budget indicators where authoritative; progress/retry/failure; asset gallery/replacement; narration; sequence/timeline; video preview; export/download/history.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's owned files without written Core Architect/Reviewer approval.
- Claiming provider/platform capabilities that are not configured and verified.



## Tasks

- [ ] **M25-T01:** Build generation project and scene view
- [ ] **M25-T02:** image/video/voice controls only for configured providers
- [ ] **M25-T03:** provider/model options only where exposed
- [ ] **M25-T04:** cost/budget indicators where authoritative
- [ ] **M25-T05:** progress/retry/failure
- [ ] **M25-T06:** asset gallery/replacement
- [ ] **M25-T07:** narration
- [ ] **M25-T08:** sequence/timeline
- [ ] **M25-T09:** video preview
- [ ] **M25-T10:** export/download/history.

## Public interface / output contract

Generation studio; scene generation; asset selection/replacement; preview and export.

## Acceptance criteria

Jobs and failures are visible and recoverable; UI never implies unconfigured providers are live.

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
