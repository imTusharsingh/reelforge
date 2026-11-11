# M34 - Localization & Multi-Platform Content Outputs

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m34-short-description`  
**Dependencies:** M07, M09-M10, M12-M13, M21 and platform decisions.

## Objective

Multilingual script variants and review; localized voice/subtitles where supported; regional settings; platform output presets/aspect ratios/duration/specs; linked reusable variants; platform-specific metadata validation.

## Scope owned by this block

Multilingual script variants and review; localized voice/subtitles where supported; regional settings; platform output presets/aspect ratios/duration/specs; linked reusable variants; platform-specific metadata validation.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's files without written approval.
- Claiming provider/platform capabilities that are not configured and verified.

## Tasks

- [ ] **M34-T01:** Multilingual script variants and review
- [ ] **M34-T02:** localized voice/subtitles where supported
- [ ] **M34-T03:** regional settings
- [ ] **M34-T04:** platform output presets/aspect ratios/duration/specs
- [ ] **M34-T05:** linked reusable variants
- [ ] **M34-T06:** platform-specific metadata validation.

## Public interface / output contract

Localization workflow; language/subtitle management; output presets; linked multi-platform variants.

## Acceptance criteria

Outputs validate against platform specs; translations are reviewable; variants retain source lineage; unsupported capabilities are explicit.

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
