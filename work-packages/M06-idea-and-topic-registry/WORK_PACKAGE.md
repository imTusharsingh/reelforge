# M06 - Idea & Topic Registry

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m06-short-description`  
**Dependencies:** M02, M03, M05, M08 (LLM port), M00.

## Objective

Generate, track, approve, and de-duplicate content ideas.

## Scope owned by this block

Idea/topic entities, status, duplicate checks, idea queue and source references.

## Explicitly outside this block

Does not scrape competitors or generate final scripts.

## Tasks

- [ ] **M06-T01:** T01 Define idea/topic lifecycle and status transitions.
- [ ] **M06-T02:** T02 Support user-entered ideas and AI-proposed ideas through typed LLM port.
- [ ] **M06-T03:** T03 Store topic, hook, angle, target audience, references/source notes, and expected format.
- [ ] **M06-T04:** T04 Implement exact/normalized title checks and text similarity checks for prior content.
- [ ] **M06-T05:** T05 Implement approval/rejection/backlog and scheduled idea selection.
- [ ] **M06-T06:** T06 Enforce cooldown and minimum diversity rules per channel/series.
- [ ] **M06-T07:** T07 Persist model/prompt versions and cost for AI idea generation.

## Public interface / output contract

Exports approved idea contract to M07.

## Acceptance criteria

- [ ] Ideas can be user-entered or AI-proposed.
- [ ] Duplicate candidates are flagged with reasons, not silently discarded.
- [ ] Approved ideas are immutable snapshots for script creation.
- [ ] No fabricated trend/source data is inserted.


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
