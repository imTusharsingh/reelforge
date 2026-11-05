# M14 - Analytics Collection & Metric Store

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m14-short-description`  
**Dependencies:** M12, M13, M01, M00.

## Objective

Collect and normalize available platform metrics with provenance and timestamps.

## Scope owned by this block

Metric catalog, metric snapshots, collection jobs, aggregate query services.

## Explicitly outside this block

Does not generate recommendations or alter content settings.

## Tasks

- [ ] **M14-T01:** T01 Define platform metric catalog with platform, account eligibility, permission, granularity, and availability notes.
- [ ] **M14-T02:** T02 Implement scheduled metric collection for YouTube using official Analytics API docs.
- [ ] **M14-T03:** T03 Implement Instagram metric collection only for metrics currently exposed and authorized.
- [ ] **M14-T04:** T04 Store immutable metric snapshots with collection time, reporting window, source API, and completeness.
- [ ] **M14-T05:** T05 Handle delayed, missing, partial, and revised platform reporting without inventing values.
- [ ] **M14-T06:** T06 Provide channel/video aggregate queries with explicit time windows.
- [ ] **M14-T07:** T07 Add retry/backoff and rate-limit handling.

## Public interface / output contract

Exports normalized metrics and completeness metadata to M15/M17.

## Acceptance criteria

- [ ] Every metric has source, period, and collection timestamp.
- [ ] Unavailable metrics are null/unavailable, never synthesized.
- [ ] Partial collection is distinguishable from zero.
- [ ] API failures do not overwrite previously valid snapshots.


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
