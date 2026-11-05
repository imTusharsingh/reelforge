# M01 - Identity & Workspace

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m01-short-description`  
**Dependencies:** M00.

## Objective

Authenticate users and enforce workspace-scoped access for all user-owned data.

## Scope owned by this block

Authentication, workspace, membership, roles, guards, tenant context.

## Explicitly outside this block

Does not own channel-specific permissions, social OAuth, or billing.

## Tasks

- [ ] **M01-T01:** T01 Implement authentication integration and user lifecycle.
- [ ] **M01-T02:** T02 Implement workspace create/read/update/archive and default workspace selection.
- [ ] **M01-T03:** T03 Implement workspace membership and v1 roles: owner, editor, viewer; invitations deferred.
- [ ] **M01-T04:** T04 Implement authorization guards and workspace context propagation.
- [ ] **M01-T05:** T05 Add workspace-scoped repository helpers and access-denial tests.
- [ ] **M01-T06:** T06 Implement secure session/logout/revocation behavior and audit-worthy auth events.

## Public interface / output contract

Provides authenticated principal, workspace context, roles, authorization guards.

## Acceptance criteria

- [ ] A user can create and access a workspace.
- [ ] A user cannot read or mutate another workspace data by changing request identifiers.
- [ ] Every protected endpoint has explicit permission requirements.
- [ ] No secrets are logged.


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
