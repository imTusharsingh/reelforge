# M33 - Research, Trends & Source Verification

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m33-short-description`  
**Dependencies:** M05-M07, M21 and research strategy.

## Objective

Topic/trend research; source links/metadata/provenance; research notes; claim-to-source mapping; fact-checking; source freshness/credibility indicators; research-assisted ideas/briefs; unsupported/disputed claim flags.

## Scope owned by this block

Topic/trend research; source links/metadata/provenance; research notes; claim-to-source mapping; fact-checking; source freshness/credibility indicators; research-assisted ideas/briefs; unsupported/disputed claim flags.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's files without written approval.
- Claiming provider/platform capabilities that are not configured and verified.

## Tasks

- [ ] **M33-T01:** Topic/trend research
- [ ] **M33-T02:** source links/metadata/provenance
- [ ] **M33-T03:** research notes
- [ ] **M33-T04:** claim-to-source mapping
- [ ] **M33-T05:** fact-checking
- [ ] **M33-T06:** source freshness/credibility indicators
- [ ] **M33-T07:** research-assisted ideas/briefs
- [ ] **M33-T08:** unsupported/disputed claim flags.

## Public interface / output contract

Research workspace; source manager; fact-check workflow; research-assisted idea creation.

## Acceptance criteria

Sources are traceable; generated suggestions are distinguished from sourced facts; unverified claims are flagged.

## Files owned (proposed)

- `apps/web/**` for UI work, following the existing approved structure.
- `docs/**` for module-owned documentation.
- Module-local tests and fixtures.
- Backend/API changes only when explicitly assigned and approved.

Inspect current paths before editing. Do not create alternate patterns without approval.

## Shared-file restrictions

Do not edit root configs, `packages/contracts/**`, `packages/database/prisma/schema.prisma`, migration ordering, root route registry, or another module's owned files without written approval. Submit a contract/schema proposal when needed.

## Required test evidence

List exact commands run and actual pass/fail results in `STATUS.md`. Never claim a command passed unless executed. Tests must not make live provider calls. Live verification requires explicit owner authorization.

## Required handoff

Update `STATUS.md` with state/estimate, files changed, completed/remaining tasks, commands/results, contract/schema proposals, defects/risks/blockers, next action and decisions requiring approval.

## Done means

The module is `IMPLEMENTED_PENDING_REVIEW`, not `APPROVED`, until the Core Architect/Reviewer verifies scope, acceptance criteria, tests, security, boundaries and integration compatibility.
