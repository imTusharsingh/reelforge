# M03 - Genres, Formats & Content Series

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m03-short-description`  
**Dependencies:** M02, M00.

## Objective

Provide configurable genre templates and recurring content series without hardcoded niche logic.

## Scope owned by this block

Genre templates, genre instances, content series, content policy data.

## Explicitly outside this block

Does not generate scripts or compile prompts.

## Tasks

- [ ] **M03-T01:** T01 Define genre template data model and starter catalog.
- [ ] **M03-T02:** T02 Implement custom genre CRUD and clone-from-template.
- [ ] **M03-T03:** T03 Define genre fields: audience, tone, topics allowed/blocked, language, structure, duration preference, safety profile.
- [ ] **M03-T04:** T04 Implement content series CRUD under a channel.
- [ ] **M03-T05:** T05 Define series-level format, frequency, character group, and prompt references.
- [ ] **M03-T06:** T06 Add validation for incompatible channel/genre/series settings.

## Public interface / output contract

Exports validated genre/series configuration to M05-M07.

## Acceptance criteria

- [ ] Users can create and edit a custom genre.
- [ ] A series belongs to exactly one channel and references a valid genre.
- [ ] No genre behavior is hardcoded in production branches.
- [ ] Invalid combinations return actionable validation errors.


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
