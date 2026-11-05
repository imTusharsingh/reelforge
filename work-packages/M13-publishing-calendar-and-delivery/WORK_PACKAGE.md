# M13 - Publishing Calendar & Delivery

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m13-short-description`  
**Dependencies:** M02, M10, M11, M12, M16, M18, M00.

## Objective

Schedule and publish approved content through connected platform adapters.

## Scope owned by this block

Calendar, scheduled posts, platform metadata, publish jobs, post status and remote IDs.

## Explicitly outside this block

Does not collect or interpret analytics.

## Tasks

- [ ] **M13-T01:** T01 Define destination post metadata and platform-specific mapping schema.
- [ ] **M13-T02:** T02 Implement content calendar and scheduled post CRUD.
- [ ] **M13-T03:** T03 Implement preflight: approval, hard gates, media, metadata, account, scope, schedule, budget.
- [ ] **M13-T04:** T04 Implement YouTube upload including resumable/reconciliation behavior where supported by official docs.
- [ ] **M13-T05:** T05 Implement per-destination publishing status and remote ID persistence.
- [ ] **M13-T06:** T06 Prevent duplicate side effects with idempotency and uncertain-outcome reconciliation.
- [ ] **M13-T07:** T07 Implement retry, reschedule, cancel, and manual publish actions.
- [ ] **M13-T08:** T08 Implement Instagram publish route when M12 adapter is approved.

## Public interface / output contract

Exports published-post records to M14.

## Acceptance criteria

- [ ] Only approved content passing hard gates can be published.
- [ ] No post can be published without explicit publish policy/authorization.
- [ ] Upload result is verified and remote ID is stored.
- [ ] Timeouts are reconciled before any retry that could duplicate a post.


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
