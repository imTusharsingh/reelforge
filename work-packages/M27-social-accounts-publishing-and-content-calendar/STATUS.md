# M27 Status — Social Accounts, Publishing & Content Calendar

- State: IMPLEMENTED_PENDING_REVIEW
- Branch: work/m27-publishing-and-calendar-ui; draft PR #93, refs #82.
- Session: Codex cloud continuation of c9c2537, 2026-11-13.
- Reviewer: Minu. No implementation-agent approval or merge.

## Implemented scope

- M27-T01/T02: supported connect/disconnect/reconnect, health/refresh, read-only platform capabilities; verified workspace roles; Instagram always unavailable. Availability checks connector/callback/token-vault readiness and publishing-session-vault readiness without exposing configuration.
- M27-T03/T04: approved-render composer, YouTube metadata/disclosure, publish-now/schedule, server preflight evidence, busy/duplicate-submit protection, and persisted delivery state.
- M27-T05/T06: date-range calendar plus unscheduled drafts, post detail, reschedule/move to draft/cancel before attempts. Unsupported metadata edits stay unavailable after an attempt.
- M27-T07/T08/T09: delivery history, retry/reconcile according to backend state, safe OAuth messages, interrupted creation replay with the exact saved clientRequestId/payload, and account-action refresh/inspection/acknowledgment recovery across reload.
- D1: GET publishing/platforms; viewer read allowed; Instagram false regardless of configuration.
- D2: optional UUID clientRequestId plus canonical request SHA-256, workspace unique index, 201 create/200 replay/409 IDEMPOTENCY_KEY_CONFLICT, unique-race reread, and cursor-paginated GET posts?status=DRAFT. Existing destination keys unchanged.
- D3: fixed WEB_APP_ORIGIN callback 302 with connected account ID or an allow-listed error code; JSON fallback when unset; one-use state retained. .env.example documents the origin.
- D4: paginated eligible renders reuse the extracted quality current-review predicate/order. Latest pending/rejected/superseded/replaced runs and unavailable artifacts are excluded. No asset URLs/storage keys returned. Creation retains server-side approval re-checking.

## Authorized files and migration

Core approvals: PR #93 comments 6845543699 (D1–D3) and 6845690430 (D4).

Changed paths: publishing/social-accounts API and tests; the dispatcher integration fixture (new-create rejection plus seeded legacy-draft publish refusal); extracted quality.current-review helper and quality service use; apps/web/features/publishing/** and publishing routes, AppShell, globals.css; scheduled-post schema and one additive migration; .env.example; module status and WORK_LOG. No ci.yml, PROJECT_STATE, dependency pins, .env, .local-* or .vscode edits.

One M27 migration adds nullable client_request_id/client_request_hash and their workspace unique index. Its unmerged directory was renamed from 20261121010000_m27_idempotent_posts to 20261121020000_m27_idempotent_posts after C3 used the same timestamp. SQL unchanged; existing main migrations remain immutable.

## Verification

Exact Node 24.22.2 / pnpm 12.16.1. Main was merged, then pnpm install --frozen-lockfile passed. Disposable PostgreSQL 18.6 on 55440; no live AI/social calls.

- Focused publishing/social-account/web tests: 13 files / 84 tests passed.
- Real persisted tests cover HTTP 201/200/conflict, concurrent service insert race with one post/destination, draft isolation, viewer reads, current approval exclusions, stable cursor paging, foreign channel 404 and unavailable artifact exclusion. Separate migration tests prove the index and legacy null-key behavior.
- Mounted Chromium: 24 scenarios passed, including 390/1440 calendar/composer/account controls, viewer restrictions, interrupted account recovery and schedule editing; provider authorization navigation is locally intercepted.
- pnpm lint, pnpm format:check, pnpm typecheck and NEXT_TELEMETRY_DISABLED=1 pnpm build passed on the merged checkout. Full DATABASE_URL=postgresql://postgres:postgres@localhost:55440/reelforge pnpm test: 109 files passed / 2 skipped; 853 tests passed / 8 skipped. The account mounted harness also passed all 12 cases after resolving the shared AppShell/CSS merge.
- db:validate and secret scan passed. db:check-migrations initially detected the timestamp collision; passed after the rename. Fresh deployment of all 32 migrations, including the renamed M27 migration, passed on the clean disposable 55440 database.
- Full tests exposed draft validation before workspace authorization; the handler now verifies context first. The dispatcher fixture now asserts D4 creation rejection, then seeds a legacy draft to retain publish-time refusal coverage. Both follow-ups pass in isolation and in the final full suite. Actual HTTP OAuth callback coverage passed all 13 tests (every redirect code and JSON fallback).

## Handoff

Latest main b64993e (including C3 and C5) was merged without rebase/force push; AppShell, CSS and work-log conflicts preserve both packs. pnpm install --frozen-lockfile passed after the merge. Next: verify exact-head hosted CI, mark #93 ready and comment Ready for Minu review. The production schedule/budget/provider ports remain fail-closed when unconfigured; fixture tests do not establish live integration readiness. No new design decisions are requested.
