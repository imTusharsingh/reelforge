# M11 - Quality Assurance & Approval

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m11-short-description`  
**Dependencies:** M03, M04, M05, M07, M10, M00.

## Objective

Run hard technical/policy checks and manage human review.

## Scope owned by this block

Quality runs, hard-gate results, scorecards, approval decisions, review queue.

## Explicitly outside this block

Does not publish or alter provider results.

## Tasks

- [ ] **M11-T01:** T01 Define hard-gate result schema and review score categories.
- [ ] **M11-T02:** T02 Implement file integrity, aspect/duration/codec/audio/subtitle checks.
- [ ] **M11-T03:** T03 Implement genre/policy checks and structured AI quality review with evidence.
- [ ] **M11-T04:** T04 Implement rights/asset provenance checks and required disclosure flags.
- [ ] **M11-T05:** T05 Implement review queue, approve/reject/request-changes decisions, and reviewer audit.
- [ ] **M11-T06:** T06 Implement configurable thresholds while preventing score from overriding a hard gate.
- [ ] **M11-T07:** T07 Implement bounded regeneration routing to the failing scene/script/render stage.

## Public interface / output contract

Exports an approved/rejected content status and gate summary to M13.

## Acceptance criteria

- [ ] A hard-gate failure cannot be approved or auto-published.
- [ ] Review decision, actor, time, and reasons are stored.
- [ ] AI score includes criterion-level evidence/limitations.
- [ ] Default policy sends content to manual review.


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
