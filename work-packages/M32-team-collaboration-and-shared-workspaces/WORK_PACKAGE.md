# M32 - Team Collaboration & Shared Workspaces

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m32-short-description`  
**Dependencies:** M01-M02, M21 and permission design.

## Objective

Workspace invitations, member management and roles; shared project ownership/access; shared ideas/scripts/storyboards; review assignments/comments; activity history; team notifications; concurrency safeguards.

## Scope owned by this block

Workspace invitations, member management and roles; shared project ownership/access; shared ideas/scripts/storyboards; review assignments/comments; activity history; team notifications; concurrency safeguards.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's files without written approval.
- Claiming provider/platform capabilities that are not configured and verified.

## Tasks

- [ ] **M32-T01:** Workspace invitations, member management and roles
- [ ] **M32-T02:** shared project ownership/access
- [ ] **M32-T03:** shared ideas/scripts/storyboards
- [ ] **M32-T04:** review assignments/comments
- [ ] **M32-T05:** activity history
- [ ] **M32-T06:** team notifications
- [ ] **M32-T07:** concurrency safeguards.

## Public interface / output contract

Team/member management; shared project and collaboration/review workflows.

## Acceptance criteria

Workspace boundaries remain enforced; role changes apply consistently; concurrent edits cannot silently overwrite.

## Files owned (proposed)

- `apps/web/**` for UI work, following the existing approved structure.
- `docs/**` for module-owned documentation.
- Module-local tests and fixtures.
- Backend/API changes only when explicitly assigned and approved.

Inspect current paths before editing. Do not create alternate patterns without approval.

## Shared-file restrictions

Do not edit root configs, `packages/contracts/**`, `packages/database/prisma/schema.prisma`, migration ordering, root route registry, or another module's owned files without written approval. Submit a contract/schema proposal when needed.

## Required test evidence

List exact commands run and actual pass/fail results in `STATUS.md`. Never claim a command passed unless executed. Tests must not make live provider calls. Live verification requires explicit owner authorization.

## Required handoff

Update `STATUS.md` with state/estimate, files changed, completed/remaining tasks, commands/results, contract/schema proposals, defects/risks/blockers, next action and decisions requiring approval.

## Done means

The module is `IMPLEMENTED_PENDING_REVIEW`, not `APPROVED`, until the Core Architect/Reviewer verifies scope, acceptance criteria, tests, security, boundaries and integration compatibility.
