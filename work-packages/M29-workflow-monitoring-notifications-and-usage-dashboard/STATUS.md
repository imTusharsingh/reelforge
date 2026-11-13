# M29 Status - Workflow Monitoring, Notifications & Usage Dashboard

- **State:** INTEGRATED (existing main merge via PR #46; documentation reconciliation only)
- **Assigned session/editor:** Codex
- **Branch/worktree:** work/m29-workflow-notifications-usage-dashboard
- **Last updated:** 2026-11-13
- **Reviewer:** minu-the-reviewer (request attempted; GitHub rejected it because the PR author is minu-the-reviewer)
- **Approved commit:** none

## Current objective

Build M16 workflow/job status and details; actionable redacted failures; retry/resume/cancel only where safe; M17 notification centre/preferences; M08/M18 usage, costs, budget limits/warnings/history; accurate usage-vs-subscription terminology.

## Completion estimate

100% of authorized frontend scope - Operations is integrated into the authenticated AppShell; privileged writes remain disabled in explicit UNKNOWN-role mode until Core provides trusted membership role metadata.

## Task checklist

- [x] **M29-T01:** Build typed workflow run monitoring view with server-driven status and recovery details.
- [x] **M29-T02:** Redacted, bounded failure messaging with accessible alert semantics.
- [x] **M29-T03:** Confirmation-gated cancel/retry/resume actions; action availability follows returned run state and backend remains authoritative.
- [x] **M29-T04:** Personal notification list, unread count, mark-read/read-all actions.
- [x] **M29-T05:** Usage totals, actual/estimated values, budget progress and exhausted state.
- [x] **M29-T06:** Usage/budget language explicitly avoids subscription, payment, and invoice claims.

## Files changed

- `apps/web/lib/operations-types.ts`
- `apps/web/lib/operations-api.ts`
- `apps/web/lib/operations-logic.ts`
- `apps/web/lib/operations.test.ts`
- `apps/web/components/operations-dashboard.tsx`
- `apps/web/components/operations-dashboard.module.css`
- `apps/web/app/operations/page.tsx`
- `apps/web/components/app-shell.tsx` (Operations navigation link and active breadcrumb)
- `apps/web/components/auth-workspace.tsx` (verified selected workspace handoff; read-only UNKNOWN role)
- `apps/web/components/studio-workspace-context.tsx` (shared verified workspace context)
- `apps/web/components/overview-screen.tsx` and `apps/web/components/operations-screen.tsx` (page-owned screen content)
- `apps/web/app/globals.css` (navigation link reset)

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
- `corepack pnpm --config.engine-strict=false --filter @reelforge/web typecheck`: PASS after Operations integration.
- `corepack pnpm --config.engine-strict=false lint`: PASS after Operations integration.
- `corepack pnpm --config.engine-strict=false format:check`: PASS after Operations integration.
- `corepack pnpm exec vitest run apps/web/components apps/web/lib`: PASS, 8 files / 24 tests.
- `corepack pnpm --config.engine-strict=false --filter @reelforge/web build`: PASS; `/` and `/operations` generated successfully.

## Contract/schema proposals

- None. M29 consumes existing M16/M17/M18 HTTP shapes without editing contracts, schema, API, or root configuration.

## Blockers / risks / unknowns

- M22 auth/session/workspace navigation is integrated on current `main`; Operations now has a real `/operations` route and normal AppShell navigation. M22 workspace list does not expose membership role, so M29 runs in explicit read-only UNKNOWN-role mode and does not expose privileged actions.
- `OperationsDashboard` requires verified `{ workspaceId, role }` from its M22 consumer; it does not discover or fabricate tenant context.
- Runtime API calls use `/api/v1` with credentials and map HTTP failures to M21 state patterns.
- PR #46 is open against `main`. Formal reviewer request to `minu-the-reviewer` returned GitHub HTTP 422 because the pull request author is that account; no approval or merge was performed.
- Review fixes: nested per-currency M18 totals and unknown/unpriced counters are validated and displayed without currency mixing; M16 enum/state/role action gates and step/job/event details are shown; M17 preference PUT/read UI and notification mutation error states are present; usage audit history is loaded; AbortController/version guards prevent stale workspace responses; focused M29 tests cover validation, redaction and permission actions.
- Current GitHub credential is `minu-the-reviewer`; commits use the repository-local developer identity `imTusharsingh` as requested.
- Re-review fixes: retry now uses actual M16 `FAILED`/`RECONCILIATION_REQUIRED` step states; approval-waiting runs expose resume; mutation continuations are generation-guarded; jobs and events are displayed individually; HTTP status errors are mapped before body parsing; period/scope/currency values are strict; owner-only budget editing is available in minor units.
- Latest review M1-M4 and product integration: merged current `origin/main` without overwriting M22 files; mutation requests abort on context changes and guard finalizers; budget edits select the existing workspace budget, preserve currency/version, and send `expectedVersion`; Operations route/navigation uses verified workspace selection and M29 renders inside the existing AppShell main landmark.
- Latest UX/architecture review: workspace switch/sign-out are persistent AppShell controls. Page ownership is now separated from authentication: `AuthWorkspace` only bootstraps the verified session/workspace and provides `WorkspaceProvider`; `/` and `/operations` each supply their own screen component. No route registry, pathname inspection, or route boolean remains in the authentication state machine.



## Historical next action (superseded by the 2026-11-13 closeout below)

Obtain Core approval for a trusted membership-role API seam, then enable OWNER/EDITOR actions from that verified role; run authenticated browser/accessibility/API smoke checks. M23 should consume the shared workspace context and AppShell rather than modifying M29 authentication logic.

## Handoff notes

M29 is user-integrated at `/operations` with read-only safety when role metadata is unavailable; it is not APPROVED or MERGED.

## Reviewer decision

- Pending.

## Main closeout — 2026-11-13 (#80)

- Existing integration: [PR #46](https://github.com/imTusharsingh/reelforge/pull/46), head `b9e0c19fec836c4d7fcc0ac8db29f2b160799f4f`, merge `d406b88b3705820617231cb2cd80d6c41e688448`. This records an existing merge; it grants no new review, approval, live-call or release authorization.
- Current scope/gaps: C1 #94 consumes the verified Workspace.role contract from #51; the obsolete UNKNOWN-role implementation blocker is resolved. #78 budget accounting and #79 E2E remain open.
- Earlier pending-review/next-action text above is historical evidence, superseded for merge state by this closeout. Earlier verification commands remain the original session's results; this documentation task does not rerun or upgrade them.
- Next action: keep release risks explicit, complete #78/#79 in their own assigned PRs, and submit this docs-only closeout for Minu review.
