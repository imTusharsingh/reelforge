# M04 - Characters & Asset Library

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m04-short-description`  
**Dependencies:** M01, M02, M00.

## Objective

Maintain reusable characters and licensed media assets with versioned references.

## Scope owned by this block

Character records, character groups, media asset catalog, upload metadata, rights metadata.

## Explicitly outside this block

Does not invoke AI image/video provider or guarantee visual identity.

## Tasks

- [ ] **M04-T01:** T01 Define character, character group, and character version models.
- [ ] **M04-T02:** T02 Add built-in starter character records/assets with documented ownership/rights.
- [ ] **M04-T03:** T03 Implement user asset upload, type/size validation, metadata, and storage adapter.
- [ ] **M04-T04:** T04 Implement character profile: description, personality, voice preference, visual invariants, variation rules.
- [ ] **M04-T05:** T05 Implement character group membership and series/channel assignment.
- [ ] **M04-T06:** T06 Implement asset versioning, checksum, usage references, and license/rights metadata.
- [ ] **M04-T07:** T07 Expose selected reference assets and immutable versions to generation jobs.

## Public interface / output contract

Exports versioned character reference package and asset URLs/IDs.

## Acceptance criteria

- [ ] A user can select a starter character or upload their own reference asset.
- [ ] Asset ownership and rights metadata are stored.
- [ ] A generated job references exact immutable character/asset versions.
- [ ] Unsupported or unsafe uploads are rejected.


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
