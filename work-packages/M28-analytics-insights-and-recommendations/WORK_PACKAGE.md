# M28 - Analytics, Insights & Recommendations

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m28-short-description`  
**Dependencies:** M14-M15, M21, M27.

## Objective

Build channel overview; published-video performance; verified M14 metrics; date filters/details/comparisons/trends/top content; supported genre/series comparisons; M15 explainable recommendations; missing/delayed/partial data states.

## Scope owned by this block

Build channel overview; published-video performance; verified M14 metrics; date filters/details/comparisons/trends/top content; supported genre/series comparisons; M15 explainable recommendations; missing/delayed/partial data states.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's owned files without written Core Architect/Reviewer approval.
- Claiming provider/platform capabilities that are not configured and verified.



## Tasks

- [ ] **M28-T01:** Build channel overview
- [ ] **M28-T02:** published-video performance
- [ ] **M28-T03:** verified M14 metrics
- [ ] **M28-T04:** date filters/details/comparisons/trends/top content
- [ ] **M28-T05:** supported genre/series comparisons
- [ ] **M28-T06:** M15 explainable recommendations
- [ ] **M28-T07:** missing/delayed/partial data states.

## Public interface / output contract

Analytics dashboard; video performance pages; trend/comparison views; recommendation area.

## Acceptance criteria

No fabricated metrics. Show provenance/time windows and qualify insufficient sample sizes.

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
