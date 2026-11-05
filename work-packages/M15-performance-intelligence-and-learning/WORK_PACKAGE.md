# M15 - Performance Intelligence & Learning

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m15-short-description`  
**Dependencies:** M03, M06, M07, M13, M14, M05, M00.

## Objective

Translate verified historical metrics into explainable recommendations and controlled experiments.

## Scope owned by this block

KPI definitions, insights, recommendation records, experiment registry.

## Explicitly outside this block

Does not fetch platform data or directly mutate prompt/channel configuration.

## Tasks

- [ ] **M15-T01:** T01 Define KPI calculations and comparison windows with minimum sample rules.
- [ ] **M15-T02:** T02 Build descriptive performance summaries by topic, hook, duration, character, series, and publish timing where data supports it.
- [ ] **M15-T03:** T03 Generate evidence-linked AI insight reports using metric snapshots as source context.
- [ ] **M15-T04:** T04 Generate ranked next-content recommendations with confidence/limitations.
- [ ] **M15-T05:** T05 Store experiments and hypotheses; avoid changing multiple dimensions without a documented design.
- [ ] **M15-T06:** T06 Require approval before applying any recommendation to channel configuration.
- [ ] **M15-T07:** T07 Feed approved, versioned strategy changes into the next planning cycle.

## Public interface / output contract

Exports approved strategy recommendations to M06/M05.

## Acceptance criteria

- [ ] Every insight links to underlying metric snapshot IDs and period.
- [ ] Insufficient data is reported as insufficient, not a confident conclusion.
- [ ] Recommendations do not change settings automatically in v1.
- [ ] Experiment results record hypothesis, variant, exposure, and outcome.


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
