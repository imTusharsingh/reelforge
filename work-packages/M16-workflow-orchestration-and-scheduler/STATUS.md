# M16 Status - Workflow Orchestration & Scheduler

- **State:** NOT_STARTED
- **Assigned session/editor:** none
- **Branch/worktree:** none
- **Last updated:** 2026-11-05
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** none

## Current objective
Coordinate durable jobs, schedules, dependencies, pause/resume, retries, and run history.

## Task checklist
- [ ] M16-T01: T01 Define workflow/run/step/job state machines and transition rules.
- [ ] M16-T02: T02 Implement BullMQ queue registry, typed job payloads, idempotency, attempts, backoff, and dead-letter handling.
- [ ] M16-T03: T03 Implement channel schedule evaluation with timezone and pause/budget/approval policy checks.
- [ ] M16-T04: T04 Implement manual run and scheduled run using the same workflow definition.
- [ ] M16-T05: T05 Implement generation workflow dependencies from idea to approved final video.
- [ ] M16-T06: T06 Implement publish workflow and analytics follow-up scheduling.
- [ ] M16-T07: T07 Implement run inspection, cancellation, retry-from-failed-step, and safe resume.
- [ ] M16-T08: T08 Persist correlation IDs and complete step-level event history.
- [ ] M16-T09: T09 Add concurrency/rate limits per workspace, channel, provider, and job type.


## Files changed
- None yet.

## Commands and evidence
- None run.

## Contract/schema proposals
- None.

## Blockers / risks / unknowns
- None recorded. Do not infer this means no risks exist; update after inspection.

## Next exact action
Read the work package and repository state, then report any conflict with existing code before implementation.

## Handoff notes
No implementation session has started.

## Reviewer decision
- Pending.
