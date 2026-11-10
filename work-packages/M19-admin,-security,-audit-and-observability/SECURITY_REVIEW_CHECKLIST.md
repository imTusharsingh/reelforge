# M19-T08 Security review checklist

Use this for every module PR review, in addition to `docs/QUALITY_GATES.md`. Record "n/a" rather
than skipping an item.

## Secrets and logging
- [ ] No secret, token, signed URL, storage key, or local file path is logged, returned in an error,
      or stored in a plain column. New log calls use the structured logger or go through the
      redacting console/framework logger.
- [ ] New secret env vars are named so `isSecretKey` matches them, or are registered with
      `registerSecretEnv`.
- [ ] Error messages that embed provider responses go through `redactString` before persistence or
      API responses (the admin views already do this).

## AuthN / AuthZ / tenancy
- [ ] Every new route has `AuthGuard` and resolves `WorkspaceService.context`; or it is added to the
      public allowlist in `admin.http.integration.test.ts` with a reason.
- [ ] Role checks match ADR-003 (OWNER for destructive/admin actions).
- [ ] Every query filters by the verified workspace id; composite `(workspace_id, id)` FKs for new
      tenant tables; a cross-tenant denial test exists.

## Input and uploads
- [ ] Bodies and query strings are parsed with Zod; ids are UUID-checked; sizes are bounded.
- [ ] Upload paths respect `ASSET_MAX_BYTES`, checksums, and type validation.

## Side effects and money
- [ ] New outbound provider calls go through M08/M18 `reservePaidCall` (paid) and are blocked by
      the M19 emergency stop; tests use fixtures only (ADR-007/ADR-010).
- [ ] Health/readiness paths make no provider calls.
- [ ] Critical user actions (auth, config, approval, connection, publishing) produce `audit_events`
      rows (the global HTTP interceptor covers mutating routes automatically; non-HTTP actions call
      `AuditService.record`).

## Data
- [ ] Migrations are additive with a new, later timestamp; applied migrations are untouched.
- [ ] Append-only tables reject UPDATE/DELETE/TRUNCATE at the database level.
- [ ] Retention/deletion/export behaviour follows an approved ADR (none exists yet; see STATUS T07).

## Dependencies and scanning
- [ ] No new third-party dependency without an exact pin and ADR-012/Core approval.
- [ ] `pnpm audit --prod` shows no known vulnerability; `pnpm audit` (all deps) findings are triaged
      in the PR. Current result is in M19 `STATUS.md`.
- [ ] CI scanning: not added. Adding `pnpm audit` (or another scanner) to `ci.yml` needs explicit
      Minu approval; the proposed step is `pnpm audit --prod --audit-level high`.
