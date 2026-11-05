# M09 - Scene Media Generation

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m09-short-description`  
**Dependencies:** M04, M05, M07, M08, M16 contracts, M00.

## Objective

Generate image/video/voice assets for each storyboard scene.

## Scope owned by this block

Scene media jobs, provider execution, generated image/video/audio assets, per-scene retry.

## Explicitly outside this block

Does not render final assembled Short or publish it.

## Tasks

- [ ] **M09-T01:** T01 Define scene generation job and asset output contract.
- [ ] **M09-T02:** T02 Resolve prompt/config/character reference package for each scene.
- [ ] **M09-T03:** T03 Generate scene images using a real configured image provider.
- [ ] **M09-T04:** T04 Generate motion/video segments only through a provider whose capabilities match the request.
- [ ] **M09-T05:** T05 Generate narration/dialogue using approved TTS provider and voice configuration.
- [ ] **M09-T06:** T06 Support per-scene retry/regenerate/replace without restarting successful scenes.
- [ ] **M09-T07:** T07 Store provider job IDs, asset IDs, metadata, source references, and cost records.
- [ ] **M09-T08:** T08 Validate generated media files and bind them to scene versions.

## Public interface / output contract

Exports a complete asset package for M10.

## Acceptance criteria

- [ ] Each scene generation has an independent status and idempotency key.
- [ ] Successful scenes are reused on retry.
- [ ] Every external generation is a real configured call and recorded.
- [ ] No empty/placeholder media is marked as generated successfully.


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
