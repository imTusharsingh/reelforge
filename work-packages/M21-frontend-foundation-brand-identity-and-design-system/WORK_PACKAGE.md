# M21 - Frontend Foundation, Brand Identity & Design System

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m21-short-description`  
**Dependencies:** M00 and existing frontend baseline.

## Objective

Create the human-led visual identity, approved screen direction, shared tokens, component library, responsive app shell and UI governance. Tasks: audit existing frontend; define brand/typography/colour/spacing/layout/icon/motion; review wireframes and high-fidelity screens before coding; implement tokens and shared components; document accessibility, responsive behaviour, loading/empty/error/success states; add component and visual regression conventions.

## Scope owned by this block

Create the human-led visual identity, approved screen direction, shared tokens, component library, responsive app shell and UI governance. Tasks: audit existing frontend; define brand/typography/colour/spacing/layout/icon/motion; review wireframes and high-fidelity screens before coding; implement tokens and shared components; document accessibility, responsive behaviour, loading/empty/error/success states; add component and visual regression conventions.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's owned files without written Core Architect/Reviewer approval.
- Claiming provider/platform capabilities that are not configured and verified.
- Building bespoke feature-module design systems; M21 owns the shared design foundation.


## Tasks

- [ ] **M21-T01:** Create the human-led visual identity, approved screen direction, shared tokens, component library, responsive app shell and UI governance. Tasks: audit existing frontend
- [ ] **M21-T02:** define brand/typography/colour/spacing/layout/icon/motion
- [ ] **M21-T03:** review wireframes and high-fidelity screens before coding
- [ ] **M21-T04:** implement tokens and shared components
- [ ] **M21-T05:** document accessibility, responsive behaviour, loading/empty/error/success states
- [ ] **M21-T06:** add component and visual regression conventions.

## Public interface / output contract

Approved design brief and key screens; shared design tokens/components; app shell; documentation.

## Acceptance criteria

No feature UI before design direction approval. All modules use shared components and tokens. The product must not look like generic AI-generated dashboard screens.

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
