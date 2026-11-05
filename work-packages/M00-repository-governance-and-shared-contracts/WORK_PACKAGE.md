# M00 - Repository Governance & Shared Contracts

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m00-short-description`  
**Dependencies:** None; first block.

## Objective

Establish repository rules, engineering quality gates, shared contracts, initial schema, CI, and bot coordination.

## Scope owned by this block

Repository scaffolding, cross-cutting developer tooling, shared contracts, root configuration.

## Explicitly outside this block

Does not implement channel features or any live external integration.

## Tasks

- [ ] **M00-T01:** T01 Initialize pnpm monorepo, strict TypeScript, formatting, lint, test framework, and build scripts.
- [ ] **M00-T02:** T02 Create apps/web, apps/api, apps/worker and shared packages with minimal bootstraps.
- [ ] **M00-T03:** T03 Define shared error envelope, pagination, correlation IDs, API versioning, and event envelope.
- [ ] **M00-T04:** T04 Define central Prisma schema baseline and migration policy for the frozen v1 domains.
- [ ] **M00-T05:** T05 Configure CI for install, lint, typecheck, unit tests, build, and migration validation without live external calls.
- [ ] **M00-T06:** T06 Add root AI editor instructions, work-package templates, contribution rules, and source-of-truth files.
- [ ] **M00-T07:** T07 Create typed event registry and contract versioning policy.

## Public interface / output contract

Exports workspace packages, base event schemas, DB client and repository conventions.

## Acceptance criteria

- [ ] A clean clone installs and builds using documented commands.
- [ ] CI is green without credentials for any external provider.
- [ ] Shared contracts and schema ownership are documented.
- [ ] No production provider adapter returns fabricated success.


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
