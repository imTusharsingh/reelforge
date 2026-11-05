# M16 - Workflow Orchestration & Scheduler

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m16-short-description`  
**Dependencies:** M00 contracts; integrated with all modules incrementally.

## Objective

Coordinate durable jobs, schedules, dependencies, pause/resume, retries, and run history.

## Scope owned by this block

Workflow definitions, scheduler, BullMQ queues/processors, run/step/job state.

## Explicitly outside this block

Does not contain creative prompts or platform-specific upload logic.

## Tasks

- [ ] **M16-T01:** T01 Define workflow/run/step/job state machines and transition rules.
- [ ] **M16-T02:** T02 Implement BullMQ queue registry, typed job payloads, idempotency, attempts, backoff, and dead-letter handling.
- [ ] **M16-T03:** T03 Implement channel schedule evaluation with timezone and pause/budget/approval policy checks.
- [ ] **M16-T04:** T04 Implement manual run and scheduled run using the same workflow definition.
- [ ] **M16-T05:** T05 Implement generation workflow dependencies from idea to approved final video.
- [ ] **M16-T06:** T06 Implement publish workflow and analytics follow-up scheduling.
- [ ] **M16-T07:** T07 Implement run inspection, cancellation, retry-from-failed-step, and safe resume.
- [ ] **M16-T08:** T08 Persist correlation IDs and complete step-level event history.
- [ ] **M16-T09:** T09 Add concurrency/rate limits per workspace, channel, provider, and job type.

## Public interface / output contract

Dispatches typed commands/jobs to modules and consumes completion events.

## Acceptance criteria

- [ ] Restarting workers does not duplicate completed side effects.
- [ ] Manual and scheduled runs use the same state machine.
- [ ] Paused channels start no new autonomous jobs.
- [ ] Every run exposes current state, failures, retries, and next action.


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
