# M31 - Subscription & SaaS Billing

**Status:** NOT_STARTED  
**Assigned session:** Unassigned  
**Branch convention:** `work/m31-short-description`  
**Dependencies:** M18, M30 and explicit commercial approval.

## Objective

Deferred commercial extension: plans and entitlements; trials; approved payment provider; checkout; invoices; upgrades/downgrades/cancellation; failed-payment recovery; billing portal; verified webhooks/reconciliation; server-side entitlement enforcement; tax/refund/compliance decisions.

## Scope owned by this block

Deferred commercial extension: plans and entitlements; trials; approved payment provider; checkout; invoices; upgrades/downgrades/cancellation; failed-payment recovery; billing portal; verified webhooks/reconciliation; server-side entitlement enforcement; tax/refund/compliance decisions.

## Explicitly outside this block

- Rebuilding completed M00-M20 backend capabilities.
- Editing shared contracts, database schema, root configuration or another module's files without written approval.
- Claiming provider/platform capabilities that are not configured and verified.

## Tasks

- [ ] **M31-T01:** Deferred commercial extension: plans and entitlements
- [ ] **M31-T02:** trials
- [ ] **M31-T03:** approved payment provider
- [ ] **M31-T04:** checkout
- [ ] **M31-T05:** invoices
- [ ] **M31-T06:** upgrades/downgrades/cancellation
- [ ] **M31-T07:** failed-payment recovery
- [ ] **M31-T08:** billing portal
- [ ] **M31-T09:** verified webhooks/reconciliation
- [ ] **M31-T10:** server-side entitlement enforcement
- [ ] **M31-T11:** tax/refund/compliance decisions.

## Public interface / output contract

Subscription/payment backend; billing UI; invoice/payment history; entitlement enforcement.

## Acceptance criteria

Backend-authoritative subscription state; verified idempotent webhooks; consistent access on payment failure. Requires explicit commercial approval. M18 usage accounting is not payment collection.

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
