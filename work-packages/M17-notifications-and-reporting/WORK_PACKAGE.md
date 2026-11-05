# M17 - Notifications & Reporting

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m17-short-description`  
**Dependencies:** M01, M02, M13, M14, M15, M16, M00.

## Objective

Deliver useful event-based notifications and scheduled channel reports.

## Scope owned by this block

Notification templates, preferences, delivery records, report snapshots.

## Explicitly outside this block

Does not calculate analytics or own workflow state.

## Tasks

- [ ] **M17-T01:** T01 Define notification event catalog and preference model.
- [ ] **M17-T02:** T02 Implement in-app notification persistence and read state.
- [ ] **M17-T03:** T03 Implement email adapter only after sender/provider credentials are configured.
- [ ] **M17-T04:** T04 Implement daily/weekly channel report assembly from verified persisted data.
- [ ] **M17-T05:** T05 Include links to failed job, review item, published post, and analytics detail.
- [ ] **M17-T06:** T06 Implement retry/de-duplication and user notification preferences.

## Public interface / output contract

Consumes typed events and sends channel/user notifications.

## Acceptance criteria

- [ ] Reports use only persisted/verified data.
- [ ] Repeated event delivery does not create duplicate notifications.
- [ ] Failed delivery is visible and retryable.
- [ ] No fake email success is returned.


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
