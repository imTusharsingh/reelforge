# M22 Status - Authentication, Workspace & Onboarding UI

- **State:** IMPLEMENTED_PENDING_REVIEW (partial: unsupported backend capabilities remain unavailable)
- **Assigned session/editor:** Codex implementation session
- **Branch/worktree:** `work/m22-auth-workspace-onboarding` / `/workspace/reelforge`
- **Last updated:** 2026-11-11
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** none

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
- FAIL/BLOCKED — initial repository-wide test: 43 suites / 213 tests passed, 36 failed because generated Prisma client was absent; after generation, no full rerun was completed.
- BLOCKED — db:validate: no disposable PostgreSQL instance was available.
- NOT RUN — browser screenshots, keyboard/dialog walkthrough, screen reader, rendered contrast and end-to-end API smoke.

## Contract/schema proposals

- Verified auth endpoints return `{ userId }` and set/revoke HttpOnly, SameSite=Strict `reelforge_session`.
- Verified workspace list/create/update/archive under `/api/v1`; list returns `id`, `name`, `archivedAt` but not membership role.
- Safe browser strategy: relative `/api/v1` calls through the Next rewrite; credentials included; no token in browser storage.
- Missing contracts requiring Core approval: password recovery; authenticated-user profile GET/PATCH; workspace membership role metadata. Do not implement these as client-side fiction.

## Blockers / risks / unknowns

- Profile edits and password recovery remain unavailable until backend contracts exist.
- Privileged role-aware navigation is withheld because roles are not returned by the workspace list.
- No explicit CSRF layer was found; Core security review should decide whether one is required before production.
- Browser visual/accessibility evidence and live API smoke remain outstanding.



## Next exact action

Run the browser walkthrough at required viewports, review the diff and security/contract gaps, then request independent review from `minu-the-reviewer`; do not merge or mark approved.

## Handoff notes

Implementation is ready for Core review with documented unsupported capabilities and verification gaps.

## Reviewer decision

- Pending.
