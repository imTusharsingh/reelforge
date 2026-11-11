# M29 - Workflow Monitoring, Notifications & Usage Dashboard

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m29-short-description`  
**Dependencies:** M16-M18, M21.

## Objective

Build M16 workflow/job status and details; actionable redacted failures; retry/resume/cancel only where safe; M17 notification centre/preferences; M08/M18 usage, costs, budget limits/warnings/history; accurate usage-vs-subscription terminology.

## Scope owned by this block

Build M16 workflow/job status and details; actionable redacted failures; retry/resume/cancel only where safe; M17 notification centre/preferences; M08/M18 usage, costs, budget limits/warnings/history; accurate usage-vs-subscription terminology.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's owned files without written Core Architect/Reviewer approval.
- Claiming provider/platform capabilities that are not configured and verified.



## Tasks

- [ ] **M29-T01:** Build M16 workflow/job status and details
- [ ] **M29-T02:** actionable redacted failures
- [ ] **M29-T03:** retry/resume/cancel only where safe
- [ ] **M29-T04:** M17 notification centre/preferences
- [ ] **M29-T05:** M08/M18 usage, costs, budget limits/warnings/history
- [ ] **M29-T06:** accurate usage-vs-subscription terminology.

## Public interface / output contract

Workflow monitoring; job detail/recovery; notification centre; usage and budget dashboard.

## Acceptance criteria

State/actions match backend; figures match accounting. M18 is usage/budget foundation, not subscription payment collection.

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
