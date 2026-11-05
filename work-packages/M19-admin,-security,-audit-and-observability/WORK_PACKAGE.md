# M19 - Admin, Security, Audit & Observability

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m19-short-description`  
**Dependencies:** M00 and all modules incrementally.

## Objective

Provide operational safety, audit history, health checks, and diagnostic visibility.

## Scope owned by this block

Audit, observability, operational controls, security rules, data lifecycle.

## Explicitly outside this block

Does not own domain workflows or creative decisions.

## Tasks

- [ ] **M19-T01:** T01 Define security baseline: secrets, RBAC, tenant isolation, input validation, upload controls.
- [ ] **M19-T02:** T02 Implement append-only audit events for auth, config changes, approvals, connections, and publishing.
- [ ] **M19-T03:** T03 Implement structured logs, correlation IDs, metrics, traces, and redaction.
- [ ] **M19-T04:** T04 Implement readiness/liveness checks without making billable provider calls.
- [ ] **M19-T05:** T05 Implement admin views for failed jobs, queue depth, provider status, and recent events.
- [ ] **M19-T06:** T06 Implement global/channel emergency stop and safe pause semantics.
- [ ] **M19-T07:** T07 Add retention/deletion/export policies for user media and credentials.
- [ ] **M19-T08:** T08 Add security review checklist and vulnerability/dependency scanning.

## Public interface / output contract

Provides shared operational services and audit sink.

## Acceptance criteria

- [ ] Secrets and private media URLs are absent from logs.
- [ ] Health checks do not create provider calls or charges.
- [ ] Critical user actions are auditable.
- [ ] Emergency stop prevents new external side effects while allowing safe reconciliation.


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
