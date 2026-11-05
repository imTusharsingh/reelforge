# M02 - Channel & Brand Management

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m02-short-description`  
**Dependencies:** M01, M00.

## Objective

Manage multiple independently configured channels within a workspace.

## Scope owned by this block

Channel aggregate, brand profile, goals, channel status and defaults.

## Explicitly outside this block

Does not own genres, characters, OAuth credentials, or workflow execution.

## Tasks

- [ ] **M02-T01:** T01 Define channel lifecycle and CRUD API/UI.
- [ ] **M02-T02:** T02 Store channel identity: name, handle, description, niche, language, audience, timezone, goals.
- [ ] **M02-T03:** T03 Store channel-level schedule, automation defaults, approval policy, and publishing destinations.
- [ ] **M02-T04:** T04 Add channel status: active, paused, archived; pause prevents new autonomous work.
- [ ] **M02-T05:** T05 Add channel overview and configuration snapshot selection.
- [ ] **M02-T06:** T06 Enforce workspace scoping and channel ownership invariants.

## Public interface / output contract

Exports channel profile and effective channel policy to downstream modules.

## Acceptance criteria

- [ ] A workspace can create multiple channels.
- [ ] A channel can be paused without deleting history.
- [ ] Channel settings are versioned or snapshot-capable.
- [ ] A paused channel cannot start scheduled generation or publishing.


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
