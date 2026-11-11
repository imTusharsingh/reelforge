# M27 - Social Accounts, Publishing & Content Calendar

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m27-short-description`  
**Dependencies:** M12-M13, M21, M25-M26.

## Objective

Build supported account connect/disconnect/reconnect; platform capability display; publishing composer and metadata; publish-now/schedule; calendar; scheduled post editing where supported; delivery history; failures/reconciliation/retry; OAuth errors and duplicate-submit prevention.

## Scope owned by this block

Build supported account connect/disconnect/reconnect; platform capability display; publishing composer and metadata; publish-now/schedule; calendar; scheduled post editing where supported; delivery history; failures/reconciliation/retry; OAuth errors and duplicate-submit prevention.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's owned files without written Core Architect/Reviewer approval.
- Claiming provider/platform capabilities that are not configured and verified.



## Tasks

- [ ] **M27-T01:** Build supported account connect/disconnect/reconnect
- [ ] **M27-T02:** platform capability display
- [ ] **M27-T03:** publishing composer and metadata
- [ ] **M27-T04:** publish-now/schedule
- [ ] **M27-T05:** calendar
- [ ] **M27-T06:** scheduled post editing where supported
- [ ] **M27-T07:** delivery history
- [ ] **M27-T08:** failures/reconciliation/retry
- [ ] **M27-T09:** OAuth errors and duplicate-submit prevention.

## Public interface / output contract

Social account management; publishing composer; calendar; delivery history and recovery.

## Acceptance criteria

Only configured platforms are available; delivery state comes from backend. Instagram remains unavailable until configured and verified.

## Files owned (proposed)

- `apps/web/**` for frontend work, following the repository's approved Next.js structure.
- `docs/**` for module-owned design/product/operational documentation.
- Module-local tests and fixtures.
- Backend/API changes only when explicitly assigned and approved; prefer existing M00-M20 contracts.

Inspect current paths before editing. Do not create alternate patterns without approval.

## Shared-file restrictions

Do not edit root configs, `packages/contracts/**`, `packages/database/prisma/schema.prisma`, migration ordering, root route registry, or another module's owned files without written approval. Submit a contract/schema proposal when needed.

## Required test evidence

List exact commands run and actual pass/fail results in `STATUS.md`. Never claim a command passed unless executed. Tests must not make live provider calls. Live verification requires explicit owner authorization.

## Required handoff

Update `STATUS.md` with state/estimate, files changed, completed/remaining tasks, commands/results, contract/schema proposals, defects/risks/blockers, next action, and decisions requiring approval.

## Done means

The module is `IMPLEMENTED_PENDING_REVIEW`, not `APPROVED`, until the Core Architect/Reviewer verifies scope, acceptance criteria, tests, security, boundaries and integration compatibility.
