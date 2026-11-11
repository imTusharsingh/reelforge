# M26 - Quality Review, Approval & Regeneration

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m26-short-description`  
**Dependencies:** M11, M21, M24-M25.

## Objective

Build review queue and video/scene review; show M11 checks and evaluator output; distinguish automated evaluation from manual review; approve/reject/request changes; notes/history; regeneration entry points; publish-readiness gate display.

## Scope owned by this block

Build review queue and video/scene review; show M11 checks and evaluator output; distinguish automated evaluation from manual review; approve/reject/request changes; notes/history; regeneration entry points; publish-readiness gate display.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's owned files without written Core Architect/Reviewer approval.
- Claiming provider/platform capabilities that are not configured and verified.



## Tasks

- [ ] **M26-T01:** Build review queue and video/scene review
- [ ] **M26-T02:** show M11 checks and evaluator output
- [ ] **M26-T03:** distinguish automated evaluation from manual review
- [ ] **M26-T04:** approve/reject/request changes
- [ ] **M26-T05:** notes/history
- [ ] **M26-T06:** regeneration entry points
- [ ] **M26-T07:** publish-readiness gate display.

## Public interface / output contract

Quality review dashboard; approval workflow; review history; regeneration entry points.

## Acceptance criteria

Backend approval gates cannot be bypassed; stale approvals are not trusted; manual review is not mislabelled as automated.

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
