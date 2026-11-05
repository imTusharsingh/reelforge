# M20 - Core Integration & Release Gate

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m20-short-description`  
**Dependencies:** All modules as they become review-ready.

## Objective

Core Architect/Reviewer only: integrate modules, verify cross-module behavior, and release.

## Scope owned by this block

Integration branches, cross-module acceptance, release evidence, project history.

## Explicitly outside this block

Does not implement module features except small integration fixes approved in review.

## Tasks

- [ ] **M20-T01:** T01 Review each work package against its scope and acceptance criteria.
- [ ] **M20-T02:** T02 Verify contracts/schema proposals and integrate shared files serially.
- [ ] **M20-T03:** T03 Run build, lint, typecheck, unit, contract, and relevant integration checks.
- [ ] **M20-T04:** T04 Execute local end-to-end flow using real local rendering and clearly marked fixtures only for offline test inputs.
- [ ] **M20-T05:** T05 Perform explicit live provider verification only when owner authorizes credentials, budget, target account, and action.
- [ ] **M20-T06:** T06 Review security, tenant isolation, cost, idempotency, and failure recovery.
- [ ] **M20-T07:** T07 Update PROJECT_STATE, WORK_LOG, module status, and release checklist.

## Public interface / output contract

Owns final integration, architecture coherence, and release decision.

## Acceptance criteria

- [ ] Every integrated module has an approval record and evidence.
- [ ] Cross-module event and data contracts match.
- [ ] No unverified fake/test integration is presented as a working feature.
- [ ] Release is blocked on unresolved critical security, publishing, or data-loss defects.


## Files owned (proposed)

- `apps/api/src/modules/<domain>/**`
- `apps/worker/src/handlers/<domain>/**` only when this block owns worker behavior
- `apps/web/src/features/<domain>/**` only when this block owns UI
- `packages/<domain>/**` only where the architecture assigns ownership
- module-local tests and documentation

Do not assume all paths already exist. Follow the repository's current approved structure. Do not create alternate patterns without approval.

## Shared-file restrictions

Do not edit root configs, `packages/contracts/**`, `packages/database/prisma/schema.prisma`, migration ordering, root route registry, or another module's owned files without written approval from the Core Architect/Reviewer. Submit a contract/schema proposal when needed.

## Required test evidence

List the exact commands run and the actual pass/fail result in `STATUS.md`. Never claim a command passed unless it was executed. Unit/contract tests must not use live external provider calls. Live verification is outside normal task scope and requires explicit owner authorization.

## Required handoff

Before ending the coding session, update `STATUS.md` with:

1. Current state and completion percentage (estimate only; do not use as approval).
2. Exact files created/changed.
3. Tasks completed and remaining.
4. Commands actually run and their outputs/result.
5. Database/contract/API changes proposed or approved.
6. Known defects, uncertainty, blockers, and risks.
7. Exact next action another session should take.
8. Any decision that needs owner/Core approval.

## Done means

The module is `IMPLEMENTED_PENDING_REVIEW`, not `APPROVED`, until the Core Architect/Reviewer verifies the acceptance criteria, tests, boundaries, security, and integration compatibility.
