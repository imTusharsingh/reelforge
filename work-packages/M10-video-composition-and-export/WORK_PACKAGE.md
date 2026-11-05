# M10 - Video Composition & Export

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m10-short-description`  
**Dependencies:** M04, M07, M09, M08 (cost if applicable), M00.

## Objective

Compose generated scene assets into a validated vertical video.

## Scope owned by this block

Render jobs, FFmpeg orchestration, subtitle/cover rendering, final video artifacts.

## Explicitly outside this block

Does not generate source footage or upload to social platforms.

## Tasks

- [ ] **M10-T01:** T01 Define render profile and destination-neutral output specification.
- [ ] **M10-T02:** T02 Validate source media, dimensions, codecs, frame rates, audio streams, and durations.
- [ ] **M10-T03:** T03 Implement deterministic FFmpeg composition of scenes, transitions, narration, licensed music/SFX, and captions.
- [ ] **M10-T04:** T04 Implement subtitles/caption timing and safe margins.
- [ ] **M10-T05:** T05 Generate cover/thumbnail candidates from approved frames.
- [ ] **M10-T06:** T06 Export final MP4 and metadata manifest; calculate checksum and duration.
- [ ] **M10-T07:** T07 Implement render retry/cancel and output artifact retention.
- [ ] **M10-T08:** T08 Support bounded edit operations: replace scene, audio, subtitle, title/cover, then rerender.

## Public interface / output contract

Exports final media manifest for M11/M13.

## Acceptance criteria

- [ ] A render is reproducible from pinned input asset IDs and render profile.
- [ ] Final artifact passes technical validation and has checksum/metadata.
- [ ] FFmpeg arguments are safely constructed; no shell injection.
- [ ] A failed scene/render cannot be reported as a successful final video.


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
