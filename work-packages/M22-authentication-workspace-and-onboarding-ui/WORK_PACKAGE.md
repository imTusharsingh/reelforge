# M22 - Authentication, Workspace & Onboarding UI

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m22-short-description`  
**Dependencies:** M01, M21.

## Objective

Build sign-in/out and registration/recovery only where supported; workspace creation, selection and switching; profile/settings; first-run onboarding; setup checklist; role-aware navigation; session expiry and accessible validation/error states.

## Scope owned by this block

Build sign-in/out and registration/recovery only where supported; workspace creation, selection and switching; profile/settings; first-run onboarding; setup checklist; role-aware navigation; session expiry and accessible validation/error states.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's owned files without written Core Architect/Reviewer approval.
- Claiming provider/platform capabilities that are not configured and verified.



## Tasks

- [ ] **M22-T01:** Build sign-in/out and registration/recovery only where supported
- [ ] **M22-T02:** workspace creation, selection and switching
- [ ] **M22-T03:** profile/settings
- [ ] **M22-T04:** first-run onboarding
- [ ] **M22-T05:** setup checklist
- [ ] **M22-T06:** role-aware navigation
- [ ] **M22-T07:** session expiry and accessible validation/error states.

## Public interface / output contract

Authentication experience; workspace selector/creation; profile/settings; onboarding journey.

## Acceptance criteria

Users reach only authorized workspaces. UI reflects existing backend capabilities and authorization; no parallel auth implementation.

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
