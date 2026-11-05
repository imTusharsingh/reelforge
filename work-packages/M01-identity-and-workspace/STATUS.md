# M01 Status - Identity & Workspace

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Codex implementation session
- **Branch/worktree:** `work/m01-identity-and-workspace`
- **Last updated:** 2026-11-06
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
- [x] M01-T05: T05 Add workspace-scoped repository helpers and access-denial tests.
- [x] M01-T06: T06 Implement secure session hashing, logout/revocation, and persisted auth events.


## Files changed
- `apps/api/package.json`, `apps/api/src/app.module.ts`, `apps/api/src/modules/identity/**`, and `apps/api/src/modules/workspace/**`.
- `packages/database/prisma/schema.prisma` and additive migration `20261105130000_identity_workspace`.

## Commands and evidence
- `git switch -c work/m01-identity-and-workspace`: passed; branch created from `main` at `773c1792dc9369172e8431944d979754dc9a1b30`.
- `corepack pnpm install` with Node `v24.22.2` and pnpm `12.16.1`: passed; lockfile updated.
- `corepack pnpm install --frozen-lockfile`: passed; lockfile current.
- `corepack pnpm lint`: passed.
- `corepack pnpm format:check`: passed; all matched files use Prettier code style.
- `corepack pnpm typecheck`: passed across all workspaces; Prisma Client 7.10.1 generated.
- `corepack pnpm test`: passed; 4 files / 12 tests.
- `corepack pnpm build`: passed across all workspaces.
- `corepack pnpm db:validate`: passed; schema valid.
- `corepack pnpm db:migrate:deploy` using `.env.example` at `127.0.0.1:5432`: not passed; existing server rejected the placeholder credentials (`P1000`).
- `corepack pnpm db:migrate:deploy` using disposable PostgreSQL 18.6 at `127.0.0.1:55432`: passed; all 3 migrations applied, then container stopped.

## Contract/schema proposals
- Additive schema change pending Core review: password credentials, hashed sessions with revocation/expiry, structured auth events, workspace archive timestamp, and user default workspace relation.

## Blockers / risks / unknowns
- No known verification blocker remains. The first migration attempt against the pre-existing local port failed authentication; the required migration check passed against disposable PostgreSQL.

## Next exact action
Review the pushed head on PR #4. Do not merge; only the repository owner merges after Minu's written approval.

## Handoff notes
No implementation session has started.

## Reviewer decision
- Pending.
