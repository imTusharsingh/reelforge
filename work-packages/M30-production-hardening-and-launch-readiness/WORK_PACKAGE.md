# M30 - Production Hardening & Launch Readiness

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m30-short-description`  
**Dependencies:** M00-M29 as applicable and production decisions.

## Objective

Verify production AI adapters and quality evaluator/manual-review path; production S3-compatible storage; KMS/key delivery/rotation; Prisma Client/Nest ESM runtime fix; retention/deletion/export and audit retention ADR; platform scope; large-video streaming; secrets/env/migrations/workers/observability/backup/restore/rate limits/security scans/error tracking/E2E/CI-CD/deployment/rollback.

## Scope owned by this block

Verify production AI adapters and quality evaluator/manual-review path; production S3-compatible storage; KMS/key delivery/rotation; Prisma Client/Nest ESM runtime fix; retention/deletion/export and audit retention ADR; platform scope; large-video streaming; secrets/env/migrations/workers/observability/backup/restore/rate limits/security scans/error tracking/E2E/CI-CD/deployment/rollback.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's owned files without written Core Architect/Reviewer approval.
- Claiming provider/platform capabilities that are not configured and verified.



## Tasks

- [ ] **M30-T01:** Verify production AI adapters and quality evaluator/manual-review path
- [ ] **M30-T02:** production S3-compatible storage
- [ ] **M30-T03:** KMS/key delivery/rotation
- [ ] **M30-T04:** Prisma Client/Nest ESM runtime fix
- [ ] **M30-T05:** retention/deletion/export and audit retention ADR
- [ ] **M30-T06:** platform scope
- [ ] **M30-T07:** large-video streaming
- [ ] **M30-T08:** secrets/env/migrations/workers/observability/backup/restore/rate limits/security scans/error tracking/E2E/CI-CD/deployment/rollback.

## Public interface / output contract

Operational/admin screens; production configuration; deployment/rollback docs; security/retention evidence; production verification report.

## Acceptance criteria

No fixture/local-only dependencies in production; critical workflows verified; backups and rollback rehearsed; release gate records evidence.

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
