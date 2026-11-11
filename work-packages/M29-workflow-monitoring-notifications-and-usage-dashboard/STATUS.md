# M29 Status - Workflow Monitoring, Notifications & Usage Dashboard

- **State:** IMPLEMENTED_PENDING_REVIEW (partial integration; review fixes prepared)
- **Assigned session/editor:** Codex
- **Branch/worktree:** work/m29-workflow-notifications-usage-dashboard
- **Last updated:** 2026-11-11
- **Reviewer:** minu-the-reviewer (request attempted; GitHub rejected it because the PR author is minu-the-reviewer)
- **Approved commit:** none

## Current objective

Build M16 workflow/job status and details; actionable redacted failures; retry/resume/cancel only where safe; M17 notification centre/preferences; M08/M18 usage, costs, budget limits/warnings/history; accurate usage-vs-subscription terminology.

## Completion estimate

90% - review blockers B1-B6 addressed in isolated feature code; live shell/auth integration is blocked until M22 is integrated.

## Task checklist

- [x] **M29-T01:** Build typed workflow run monitoring view with server-driven status and recovery details.
- [x] **M29-T02:** Redacted, bounded failure messaging with accessible alert semantics.
- [x] **M29-T03:** Confirmation-gated cancel/retry/resume actions; action availability follows returned run state and backend remains authoritative.
- [x] **M29-T04:** Personal notification list, unread count, mark-read/read-all actions.
- [x] **M29-T05:** Usage totals, actual/estimated values, budget progress and exhausted state.
- [x] **M29-T06:** Usage/budget language explicitly avoids subscription, payment, and invoice claims.

## Files changed

- `apps/web/features/m29/types.ts`
- `apps/web/features/m29/api.ts`
- `apps/web/features/m29/dashboard.tsx`
- `apps/web/features/m29/m29.module.css`
- `apps/web/features/m29/index.ts`

## Commands and evidence

- `corepack pnpm install --frozen-lockfile`: BLOCKED by Node 24.22.1 vs pinned 24.22.2; rerun with `--config.engine-strict=false`.
- `corepack pnpm install --frozen-lockfile --config.engine-strict=false`: PASS.
- `corepack pnpm --config.engine-strict=false --filter @reelforge/web typecheck`: PASS.
- `corepack pnpm --config.engine-strict=false lint`: PASS.
- `corepack pnpm --config.engine-strict=false format:check`: PASS after formatting M29 files.
- `PATH=/tmp/reelforge-bin:$PATH DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reelforge pnpm --config.engine-strict=false -r --if-present typecheck`: PASS.
- `PATH=/tmp/reelforge-bin:$PATH DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reelforge pnpm --config.engine-strict=false build`: PASS.
- `PATH=/tmp/reelforge-bin:$PATH DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reelforge pnpm --config.engine-strict=false db:validate`: PASS.
- `corepack pnpm --config.engine-strict=false test` after Prisma generation: FAIL: 20 API suites / 19 tests failed because the configured local PostgreSQL database is not migrated; 58 suites passed, 2 skipped, 363 tests passed, 148 skipped. No M29 suite failed.

## Contract/schema proposals

- None. M29 consumes existing M16/M17/M18 HTTP shapes without editing contracts, schema, API, or root configuration.

## Blockers / risks / unknowns

- M22 auth/session/workspace navigation is absent from this branch. No route or shell wiring was added because M29 cannot safely obtain verified workspace context here.
- `M29Dashboard` requires verified `{ workspaceId, role }` from its eventual M22 consumer; it does not discover or fabricate tenant context.
- Runtime API calls use `/api/v1` with credentials and map HTTP failures to M21 state patterns.
- PR #46 is open against `main`. Formal reviewer request to `minu-the-reviewer` returned GitHub HTTP 422 because the pull request author is that account; no approval or merge was performed.
- Review fixes: nested per-currency M18 totals and unknown/unpriced counters are validated and displayed without currency mixing; M16 enum/state/role action gates and step/job/event details are shown; M17 preference PUT/read UI and notification mutation error states are present; usage audit history is loaded; AbortController/version guards prevent stale workspace responses; focused M29 tests cover validation, redaction and permission actions.
- Current GitHub credential is `minu-the-reviewer`; developer account authentication is unavailable in this environment, so the fix commit is intentionally not pushed under the reviewer identity.



## Next exact action

Integrate `M29Dashboard` from the M22 authenticated workspace route using verified workspace context, then run browser/accessibility checks against authenticated API responses.

## Handoff notes

M29 feature code is ready for independent review, but is not user-integrated until M22 supplies auth/session/workspace wiring.

## Reviewer decision

- Pending.
