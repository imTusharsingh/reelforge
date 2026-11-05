# M08 - AI Provider Registry & Cost Ledger

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m08-short-description`  
**Dependencies:** M00; consumed by M06/M07/M09.

## Objective

Expose provider-neutral AI capabilities and record real provider use and costs.

## Scope owned by this block

Provider ports/registry/capabilities, provider adapters, usage/cost ledger, budget check service.

## Explicitly outside this block

Does not choose ideas, prompts, or creative policy.

## Tasks

- [ ] **M08-T01:** T01 Define provider-neutral interfaces for LLM, image, video, and TTS capabilities.
- [ ] **M08-T02:** T02 Define capability metadata: supported input/output, reference-image support, duration/resolution limits, async/polling, region, and cost model.
- [ ] **M08-T03:** T03 Implement approved provider registry and per-environment credentials.
- [ ] **M08-T04:** T04 Implement request validation and normalized error taxonomy.
- [ ] **M08-T05:** T05 Record each actual request, response metadata, usage, estimated/actual cost, latency, and correlation IDs.
- [ ] **M08-T06:** T06 Implement workspace/channel budgets, daily caps, preflight estimate, and spend guard.
- [ ] **M08-T07:** T07 Add real-provider health/capability checks that are explicitly invoked, never run automatically on startup or in CI.

## Public interface / output contract

Exports provider ports and usage/cost results to modules.

## Acceptance criteria

- [ ] A module cannot invoke a provider without a registered capability and credential.
- [ ] Every paid call has a cost/usage record or explicit unknown-cost state.
- [ ] Budget limits prevent new calls before dispatch.
- [ ] No fake adapter returns success in runtime.


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
