# M05 - Configuration & Prompt Engine

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m05-short-description`  
**Dependencies:** M02, M03, M04, M00.

## Objective

Resolve hierarchical configuration and compile versioned prompts deterministically.

## Scope owned by this block

Configuration schemas, merge resolver, prompt templates/versions, resolved snapshots.

## Explicitly outside this block

Does not call models or decide business policy.

## Tasks

- [ ] **M05-T01:** T01 Define typed configuration schemas and defaults for each supported module.
- [ ] **M05-T02:** T02 Implement precedence and merge rules: platform, workspace, channel, genre, series, character, video override.
- [ ] **M05-T03:** T03 Implement locked fields and protected system/platform/safety rules.
- [ ] **M05-T04:** T04 Implement prompt template CRUD, versioning, activation, rollback, and variables.
- [ ] **M05-T05:** T05 Compile prompt bundles from resolved configuration and user additions.
- [ ] **M05-T06:** T06 Persist immutable config and prompt snapshots against every generation job.
- [ ] **M05-T07:** T07 Add a prompt preview/validation interface without executing an AI call.

## Public interface / output contract

Exports resolved configuration and compiled prompt bundle to downstream jobs.

## Acceptance criteria

- [ ] Same inputs and versions resolve to the same effective configuration.
- [ ] Higher layers cannot override locked safety/system rules.
- [ ] Every generation job references exact prompt/config versions.
- [ ] Prompt preview never triggers provider calls.


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
