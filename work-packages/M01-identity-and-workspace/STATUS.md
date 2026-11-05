# M01 Status - Identity & Workspace

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Codex implementation session
- **Branch/worktree:** `work/m01-identity-and-workspace`
- **Last updated:** 2026-11-05
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** none

## Current objective
Authenticate users and enforce workspace-scoped access for all user-owned data.

## Scope summary (2026-11-05)
M01 owns first-party authentication, user lifecycle, workspace CRUD/archive/default selection, workspace membership and owner/editor/viewer authorization, protected-request workspace context, scoped repository helpers, revocation/logout, and structured auth events. Dependencies are the integrated M00 monorepo, NestJS API bootstrap, shared contracts, and the existing Prisma `User`, `Workspace`, `WorkspaceMembership`, and `WorkspaceRole` baseline. Likely changes are confined to `apps/api/src/modules/identity` and `apps/api/src/modules/workspace`, additive Prisma schema/migration changes, module-local tests, this status file, and the append-only work log. No conflict was found in the authoritative documents; the auth IdP remains unchosen, so this implementation uses first-party credentials as explicitly required by the assignment. Invitations, social OAuth, billing, and channel permissions remain out of scope.

## Task checklist
- [x] M01-T01: T01 Implement first-party password authentication and user lifecycle.
- [x] M01-T02: T02 Implement workspace create/read/archive and default workspace selection.
- [x] M01-T03: T03 Implement membership lookup and owner/editor/viewer role enforcement; invitations deferred.
- [x] M01-T04: T04 Implement authentication guard and verified workspace context propagation.
- [ ] M01-T05: T05 Add workspace-scoped repository helpers and access-denial tests.
- [x] M01-T06: T06 Implement secure session hashing, logout/revocation, and persisted auth events.


## Files changed
- `apps/api/package.json`, `apps/api/src/app.module.ts`, `apps/api/src/modules/identity/**`, and `apps/api/src/modules/workspace/**`.
- `packages/database/prisma/schema.prisma` and additive migration `20261105130000_identity_workspace`.

## Commands and evidence
- `git switch -c work/m01-identity-and-workspace`: passed; branch created from `main` at `773c1792dc9369172e8431944d979754dc9a1b30`.
- Required install, lint, typecheck, tests, build, Prisma validation, and migration deploy: **not run**; Node.js and pnpm are unavailable in PATH, and the API dependency addition is not lockfile-resolved.

## Contract/schema proposals
- Additive schema change pending Core review: password credentials, hashed sessions with revocation/expiry, structured auth events, workspace archive timestamp, and user default workspace relation.

## Blockers / risks / unknowns
- Verification is blocked by the missing pinned Node/pnpm toolchain; no passing test or build result is claimed.
- `apps/api/package.json` requires a lockfile update before frozen install can pass.
- M01-T05 denial tests remain to be added and run once the toolchain is available.

## Next exact action
Provision Node 24.22.2/pnpm 12.16.1, update `pnpm-lock.yaml`, run all required checks including cross-workspace denial tests, then request Minu review. Do not merge.

## Handoff notes
No implementation session has started.

## Reviewer decision
- Pending.
