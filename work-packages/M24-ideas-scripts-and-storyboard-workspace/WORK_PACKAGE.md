# M24 - Ideas, Scripts & Storyboard Workspace

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m24-short-description`  
**Dependencies:** M06-M07, M21, M23.

## Objective

Build idea discovery/list/create/edit/archive/search/filter/status; idea brief; M07 script generation/editing; version history only where supported; storyboard scene breakdown; ordering/timing; character/asset assignment; targeted revision; save/recovery and unsaved-change handling.

## Scope owned by this block

Build idea discovery/list/create/edit/archive/search/filter/status; idea brief; M07 script generation/editing; version history only where supported; storyboard scene breakdown; ordering/timing; character/asset assignment; targeted revision; save/recovery and unsaved-change handling.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's owned files without written Core Architect/Reviewer approval.
- Claiming provider/platform capabilities that are not configured and verified.



## Tasks

- [ ] **M24-T01:** Build idea discovery/list/create/edit/archive/search/filter/status
- [ ] **M24-T02:** idea brief
- [ ] **M24-T03:** M07 script generation/editing
- [ ] **M24-T04:** version history only where supported
- [ ] **M24-T05:** storyboard scene breakdown
- [ ] **M24-T06:** ordering/timing
- [ ] **M24-T07:** character/asset assignment
- [ ] **M24-T08:** targeted revision
- [ ] **M24-T09:** save/recovery and unsaved-change handling.

## Public interface / output contract

Ideas workspace; script editor; storyboard and scene editor; planning workflow.

## Acceptance criteria

Idea-to-storyboard flow works end-to-end; edits persist; scene order/text/assignments match backend state.

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
