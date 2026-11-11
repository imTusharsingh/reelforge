# M22 Status - Authentication, Workspace & Onboarding UI

- **State:** INTEGRATED (PR #44 merged; unsupported backend capabilities and production gates remain open)
- **Assigned session/editor:** Codex implementation session
- **Branch/worktree:** `work/m22-auth-workspace-onboarding` / `/workspace/reelforge`
- **Last updated:** 2026-11-11
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** `4786bd5a71e411c4e806725130e8cc8646faffd7`
- **Merge commit:** `3782c2e74f2ff59d4453db2d218b38b6e97eac26`

## Current objective

Build sign-in/out and registration/recovery only where supported; workspace creation, selection and switching; profile/settings; first-run onboarding; setup checklist; role-aware navigation; session expiry and accessible validation/error states.

## Completion estimate

85% of authorized frontend scope; recovery, profile editing and verified role-aware privileges are blocked by missing API contracts.

## Task checklist

- [x] **M22-T01:** Sign-in, registration, logout, password visibility, validation, loading and API failure states. Recovery is explicitly unavailable because no recovery endpoint exists.
- [x] **M22-T02:** Authenticated workspace listing, creation, selection, switching and local-only active workspace preference. API remains authoritative.
- [x] **M22-T03:** Read-only settings unavailable state; no unsupported account mutation is simulated.
- [x] **M22-T04:** First-run workspace onboarding grounded in actual API capabilities.
- [x] **M22-T05:** Accessible verified/incomplete/later setup checklist in the context rail.
- [x] **M22-T06:** Existing M21 shell reused; future routes remain non-clickable and no roles are guessed.
- [x] **M22-T07:** 401/403/network/error handling, duplicate-submit prevention and accessible form/status markup.

## Files changed

- `apps/web/app/globals.css`, `apps/web/app/page.tsx`, `apps/web/next.config.ts`
- `apps/web/components/auth-workspace.tsx`, `apps/web/components/auth-workspace.test.ts`
- `apps/web/lib/api.ts`, `apps/web/lib/auth-validation.ts`
- This status file and `docs/WORK_LOG.md`

## Commands and evidence

- PASS — frozen install via Corepack pnpm 12.16.1 (host Node 24.22.1 vs pinned 24.22.2).
- PASS — lint, format:check, root typecheck with a syntactically valid DATABASE_URL, and web build.
- PASS — focused M21/M22 frontend tests: 5 files, 13 tests.
- PASS — review-fix frontend tests: 6 files, 16 tests, including logout policy and malformed response guards.
- PASS — GitHub Actions CI run `42997824300` on head `3c9739f`: quality, migrations, dependency audit, production build, unit/integration tests and required CI.
- PASS — latest review-fix frontend tests: 7 files, 17 tests, including request-generation invalidation.
- PASS — local review-fix lint, format:check, typecheck, web build and diff check.
- PASS — latest race-fix frontend tests: 7 files, 18 tests, including deferred stale success and rejection paths.
- FAIL/BLOCKED — initial repository-wide test: 43 suites / 213 tests passed, 36 failed because generated Prisma client was absent; after generation, no full rerun was completed.
- BLOCKED — db:validate: no disposable PostgreSQL instance was available.
- NOT RUN — browser screenshots, keyboard/dialog walkthrough, screen reader, rendered contrast and end-to-end API smoke.

## Contract/schema proposals

- Verified auth endpoints return `{ userId }` and set/revoke HttpOnly, SameSite=Strict `reelforge_session`.
- Verified workspace list/create/update/archive under `/api/v1`; list returns `id`, `name`, `archivedAt` but not membership role.
- Safe browser strategy: relative `/api/v1` calls through the Next rewrite; credentials included; no token in browser storage.
- Missing contracts requiring Core approval: password recovery; authenticated-user profile GET/PATCH; workspace membership role metadata. Do not implement these as client-side fiction.
- Security disposition: SameSite=Strict and same-origin proxying are not treated as complete CSRF/origin protection. Production security acceptance is blocked pending a Core-approved strategy; no backend change was made in M22.
- Review fixes: authenticated requests carry a monotonic generation guard; stale responses cannot restore state after logout, expiry or workspace switch. Workspace creation verifies the created ID in the refreshed authorized list before selection. 401/403 refresh failures clear protected state; transport failures remain recoverable.
- Race-fix details: the generation is captured for the entire async operation and checked before success, error and finalization state updates. Workspace creation passes its captured generation into reconciliation, so an old submit cannot select a workspace after a switch.

## Blockers / risks / unknowns

- Profile edits and password recovery remain unavailable until backend contracts exist.
- Privileged role-aware navigation is withheld because roles are not returned by the workspace list.
- No explicit CSRF layer was found; Core security review should decide whether one is required before production.
- Logout keeps the authenticated view on transport/5xx failure and only clears local state for confirmed logout or an already-invalid 401 session.
- Runtime response guards reject malformed auth, logout and workspace payloads with a safe client error.
- Browser visual/accessibility evidence and live API smoke remain outstanding.
- Latest-head CI for the current review-fix commit is not yet verified; the prior code-head CI was `42997824300`.
- Current race-fix head CI is pending; prior CI `42999228949` passed on `bc06b38`.



## Next exact action

Run the browser walkthrough at required viewports, obtain Core approval for the CSRF/origin strategy, and request independent review from an account distinct from the PR author; do not merge or mark approved.

## Handoff notes

Implementation is ready for Core review with documented unsupported capabilities and verification gaps.

## Reviewer decision

- APPROVED by `imTusharsingh` on M22 head `4786bd5a71e411c4e806725130e8cc8646faffd7` (GitHub review `5857054960`); exact-head CI run `43000401126` completed successfully.
- INTEGRATED into `main` via PR #44 at merge commit `3782c2e74f2ff59d4453db2d218b38b6e97eac26` by explicit owner authorization.
- This is **code integration only**, not production security approval or complete feature acceptance. Recovery, profile mutation and verified role-aware navigation await backend contracts; Core CSRF/origin design and browser accessibility/API smoke evidence are still open.

