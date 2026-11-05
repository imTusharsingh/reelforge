# M18 - Usage, Budget & Billing Foundation

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m18-short-description`  
**Dependencies:** M01, M02, M08, M09, M10, M13, M16, M00.

## Objective

Control provider spending and expose transparent per-channel usage.

## Scope owned by this block

Usage ledger, reservations, budgets, cost reporting.

## Explicitly outside this block

Does not call providers or implement subscriptions.

## Tasks

- [ ] **M18-T01:** T01 Define usage categories and cost ledger joins for workspace/channel/video/job.
- [ ] **M18-T02:** T02 Implement configurable daily/monthly budget limits and preflight budget reservations.
- [ ] **M18-T03:** T03 Implement hard-stop behavior when budget is exhausted; never silently bypass.
- [ ] **M18-T04:** T04 Implement usage/cost dashboard and per-video cost breakdown.
- [ ] **M18-T05:** T05 Implement admin adjustments and audit records.
- [ ] **M18-T06:** T06 Leave subscription/payment collection out of v1; define extension point only.

## Public interface / output contract

Exports budget reservation/charge and usage summaries.

## Acceptance criteria

- [ ] Spend is visible and linked to provider calls or explicitly marked estimated/unknown.
- [ ] Budget cap is checked before paid calls.
- [ ] Concurrent jobs cannot overspend through race conditions.
- [ ] No billing/payment provider is integrated in v1.


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
