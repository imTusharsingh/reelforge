# M25 Status - Generation Studio & Video Production UI

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Codex M25 implementation
- **Branch/worktree:** `feat/m25-generation-studio` / `/workspace/reelforge-m25`
- **Last updated:** 2026-11-12
- **Reviewer:** `minu-the-reviewer`
- **Approved commit:** none

## Current objective

Build the generation project and scene workspace against real M08–M10, M16 and M18 capabilities without implying unavailable providers or fabricated production data.

## Completion estimate

100% of the approved M25 frontend scope is implemented; independent review and final-head hosted CI remain.

## Task checklist

- [x] **M25-T01:** Persisted production library, approved-script entry and per-scene workspace.
- [x] **M25-T02:** Image/video/voice controls gated by server capability availability and verified write role.
- [x] **M25-T03:** Server-derived capability registration metadata and explicit unavailable explanations; no invented provider/model choices.
- [x] **M25-T04:** Authoritative cost classifications, unknown-cost warning and applicable persisted budgets.
- [x] **M25-T05:** Persisted progress/failures, polling refresh, scene retry/regeneration, render cancel/retry, version tokens and ambiguous-response reconciliation.
- [x] **M25-T06:** Authorized asset gallery and existing output regeneration; selected-asset assignment visibly disabled because Core did not approve that contract.
- [x] **M25-T07:** Approved narration/dialogue and persisted voice-output state per scene.
- [x] **M25-T08:** Approved script scene order/timing timeline and pinned revision context.
- [x] **M25-T09:** Authenticated asset/render previews with loading, missing/expired/unsupported/error states.
- [x] **M25-T10:** Persisted render history, artifact-state checks and authenticated download links.

## Files changed

- `apps/web/app/production/**`: production library, script entry, scene job and render routes under authenticated workspace scope.
- `apps/web/features/production/{api,model,session}.ts*`: strict frontend trust-boundary parsing, role enforcement, cancellation of workspace-scoped requests and API client.
- `apps/web/features/production/{library,start,studio,render,common}.tsx`: M25 work surfaces and safe mutation recovery.
- `apps/web/features/production/production.module.css`: responsive design-system feature styling.
- `apps/web/features/production/{api,model}.test.ts`: DTO, tenant, role, mutation-token and media-path tests.
- `apps/web/features/production/verification/**`: test-only mounted browser fixtures and runner; never imported by production code.
- `apps/web/components/app-shell.tsx` and test: enabled Production navigation and nested-route active state.
- `docs/M25_CAPABILITY_AUDIT.md`: recorded merged Core resolution.
- `docs/WORK_LOG.md`: appended implementation and exact verification evidence.
- This STATUS file.

## Commands and evidence

- `git fetch origin main`: initial transient GitHub HTTP 503; retry PASS, fetched `58b946e`.
- `git merge --no-edit origin/main`: initial WORK_LOG append-only conflict; resolved by preserving M25 audit plus both Core entries; merge commit `15dfd0a`.
- `pnpm install --frozen-lockfile`: PASS, all 12 workspace projects installed from the unchanged lockfile.
- `pnpm vitest run apps/web/features/production apps/web/components/app-shell.test.ts`: PASS, 3 files / 12 tests.
- `pnpm lint`: PASS.
- `pnpm format:check`: PASS before the final documentation update; rerun on final source below.
- `pnpm typecheck`: PASS after full workspace install.
- First `pnpm test`: FAIL due only to unavailable configured PostgreSQL at `127.0.0.1:55432` (516 passed, 170 skipped, 19 DB connection failures). No product assertion failed.
- `env -u DATABASE_URL pnpm test`: PASS offline, 516 passed / 189 skipped.
- Started the managed local PostgreSQL 17 service; `pnpm db:migrate:deploy`: PASS, migrations 28–30 applied to disposable `reelforge_dev`.
- `pnpm db:validate`: PASS.
- `pnpm db:check-migrations`: PASS, 30 ordered immutable migrations.
- Final `pnpm test` with PostgreSQL: PASS, 698 passed / 8 skipped.
- `NODE_ENV=production pnpm build`: PASS; `/production`, `/production/jobs/[jobId]`, `/production/renders/[jobId]`, `/production/scripts/[scriptId]` generated.
- Mounted Chromium: PASS, 4 scenarios at 1440px and 390px covering persisted scene/timeline/narration, provider unavailability, Viewer restrictions, unsupported assignment, authorized artifact paths, media failure and mobile overflow. Screenshot: `/tmp/m25-production-mobile.png`.
- `pnpm security:secrets`: PASS, 584 tracked files inspected.

## Contract/schema proposals

- Core #59 and #60 are merged. M25 consumed their documented contracts.
- No M25 shared contract, API, schema, migration, dependency or root-tooling change.
- Existing library-asset assignment remains absent and disabled. A future Core-approved `ASSIGN` contract is required before enabling it.

## Risks / known gaps

- Default provider bindings remain NotConfigured, so generation/regeneration controls correctly remain disabled in the current environment. A configured deployment will be enabled only from `GET /scene-media/capabilities`.
- Render creation is not exposed because the current API requires a complete validated composition input and has no server command that safely derives it from a scene package. Existing renders can be monitored, canceled, retried, previewed and downloaded.
- Browser evidence uses Chromium and isolated persisted-response fixtures. Live provider readiness, other browser engines and full screen-reader certification are not claimed.
- Branch commit and PR ownership are verified as `imTusharsingh`; PR #66 is non-draft and requests `minu-the-reviewer`.

## Next exact action

Monitor hosted checks and independent review on PR #66, address all feedback, and rerun affected checks on the final head. Do not self-approve or merge.

## Handoff notes

All supported production UI reads and actions use authenticated workspace-scoped routes. Viewer controls are disabled locally and remain server-enforced. Mutations carry Core-approved observed tokens/idempotency where supported; ambiguous cancellation is never replayed. Media URLs are API paths, never storage keys or public assumptions.

## Reviewer decision

PR #66 is open and pending independent review from `minu-the-reviewer`; not approved or integrated.
