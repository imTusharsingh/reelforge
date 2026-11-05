# M07 - Script & Storyboard

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m07-short-description`  
**Dependencies:** M03, M04, M05, M06, M08, M00.

## Objective

Convert an approved idea into a structured script and scene plan.

## Scope owned by this block

Scripts, revisions, scenes/storyboards, script validation and approval state.

## Explicitly outside this block

Does not generate images, videos, or final rendered files.

## Tasks

- [ ] **M07-T01:** T01 Define versioned JSON schema for script, hook, dialogue/narration, CTA, and metadata.
- [ ] **M07-T02:** T02 Define scene schema: timing, characters, dialogue, visual description, camera, audio cues, transitions.
- [ ] **M07-T03:** T03 Implement script generation through typed LLM provider port.
- [ ] **M07-T04:** T04 Validate duration estimates, character references, genre policy, and required sections.
- [ ] **M07-T05:** T05 Implement script revision/versioning and manual edit/approval.
- [ ] **M07-T06:** T06 Add factuality/source-reference fields for factual genres; reject unsupported factual claims where source evidence is required.
- [ ] **M07-T07:** T07 Persist prompt/model/version/cost and input snapshot IDs.

## Public interface / output contract

Exports immutable storyboard package to M09/M10.

## Acceptance criteria

- [ ] A script is structured and schema-valid.
- [ ] Scene durations sum to the configured target within tolerance.
- [ ] All referenced characters/assets exist and are version-pinned.
- [ ] Factual claims can be traced to provided/approved sources when the genre requires it.


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
