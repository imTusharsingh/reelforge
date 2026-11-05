# M12 - Social Accounts & Platform Adapters

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m12-short-description`  
**Dependencies:** M01, M02, M00.

## Objective

Connect social accounts securely and implement platform-specific API adapters.

## Scope owned by this block

Social account entities, OAuth lifecycle, platform adapters, permission/capability registry.

## Explicitly outside this block

Does not own content calendar, post approval, or analytics interpretation.

## Tasks

- [ ] **M12-T01:** T01 Define platform-neutral account/permission/capability interface.
- [ ] **M12-T02:** T02 Implement OAuth connection flow, state/CSRF protection, callback validation, token encryption, revocation.
- [ ] **M12-T03:** T03 Implement YouTube account connector using current official Data API documentation.
- [ ] **M12-T04:** T04 Implement token refresh/expiry handling and minimum scopes.
- [ ] **M12-T05:** T05 Define Instagram adapter contract and implement connector only after current official Meta requirements are verified.
- [ ] **M12-T06:** T06 Normalize platform errors, rate limits, upload sessions, and remote IDs.
- [ ] **M12-T07:** T07 Add connection health and capability display; never perform uploads during connection checks.

## Public interface / output contract

Exports authenticated platform clients and account capabilities to M13/M14.

## Acceptance criteria

- [ ] Tokens are encrypted and never logged.
- [ ] Account connection proves the authenticated channel/account identity.
- [ ] The YouTube connector uses official API endpoints and least-privilege scopes.
- [ ] Instagram eligibility/permissions/media rules are recorded from current official docs before release.


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
