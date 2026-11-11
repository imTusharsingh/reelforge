# M20 Status - Core Integration & Release Gate

- **State:** IMPLEMENTED_PENDING_REVIEW (estimate ~85%: T05 blocked on owner authorization; T04 partial at the provider boundary; T07 PROJECT_STATE update proposed, not edited)
- **Assigned session/editor:** Minu backup implementation session (local, Desktop TRACXN-LP-784, no cloud agent), run in parallel with the VS Code session on the main checkout.
- **Branch/worktree:** `work/m20-core-integration-and-release-gate-minu` in worktree `/home/tracxn-lp-784/Desktop/project/reelforge-m20-minu`, merged with latest `origin/main` `cd2ab662b727471ce65739f3db1d729c2d8229e3`; final local candidate `3eac5d2dcadf68065af1beaaef5143e4a0e0750a`.
- **Last updated:** 2026-11-11 (IST)
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** none

## Current objective
Core integration review and release gate for M00–M19: approval records, cross-module contracts, offline checks, local end-to-end evidence, security/tenant/cost review, and release evidence. No module features.

## Task checklist
- [x] **M20-T01** Approval matrix for all 20 modules (`INTEGRATION_REVIEW.md` T01). 20/20 have a written approval record; 6 are COMMENTED written approvals (M00–M04 under `imTusharsingh`, M09 author-blocked) and M06 PR #14 was merged before review and corrected by approved PR #15. Re-verified with `gh api .../pulls/<n>/reviews` on 2026-11-10 20:42 IST.
- [x] **M20-T02** Contracts and schema (`INTEGRATION_REVIEW.md` T02). Event registry vs code: findings E1–E6. Schema drift: 84 lines pre-existing, identical before/after (S1–S6). M20 changed no shared file and adds no migration. Migration ordering is now enforced by `release-gate.migrations.test.ts`.
- [x] **M20-T03** Full checks run after merging latest `origin/main` (see "Commands and evidence").
- [~] **M20-T04** Local end-to-end, **partial**. Real local rendering: with `FFMPEG_PATH`/`FFPROBE_PATH` set to FFmpeg 7.0.2-static the full suite runs **518/518 with 0 skips**, so the M10 real-render and M11 probe paths ran against real FFmpeg. The content pipeline cannot run idea → script → media → publish offline without fake success, because no AI adapter is bound (ADR-007). `release-gate.provider-boundary.integration.test.ts` proves the boundary fails clearly: every default AI / email / billing / Instagram adapter is NOT_CONFIGURED and rejects, the registry is empty, every AI capability has a `null` cost model, and an AI idea proposal over HTTP creates no idea, no ledger row and no reservation. Fixtures are marked in each test.
- [ ] **M20-T05** Live provider verification: **BLOCKED, not authorized**. Gate 4 checklist written in `RELEASE_CHECKLIST.md`; nothing live was run.
- [x] **M20-T06** Security / tenant isolation / cost / idempotency / failure recovery (`INTEGRATION_REVIEW.md` T06). Tenant sweep covers 159 `:workspaceId` routes as another workspace's OWNER; representative valid-payload channel create/update mutations assert 403 and zero victim-side effects; all 159 return 401 without a session; unscoped routes pinned to a reviewed allowlist of 8. Findings C1 (HIGH), C2 (LOW), C3 (owner gates). M10–M19 residuals and PR #36 N1–N4 carried.
- [~] **M20-T07** This `STATUS.md`, `INTEGRATION_REVIEW.md`, `RELEASE_CHECKLIST.md`, and a `docs/WORK_LOG.md` entry are done. `docs/PROJECT_STATE.md` was **not** edited (standing rule: no PROJECT_STATE edit in a product PR); the proposed change is below for the docs-only closeout.

## Files changed
- `apps/api/src/modules/release-gate/release-gate.http.integration.test.ts` (new; adapted from the VS Code session's draft): tenant sweep, 401 sweep, reviewed unscoped-route allowlist, sweep sanity, M13 outbox → registry → M17 intake round trip, `fetch` spy.
- `apps/api/src/modules/release-gate/release-gate.provider-boundary.integration.test.ts` (new): default-binding provider boundaries, no charge, no network.
- `apps/api/src/modules/release-gate/release-gate.migrations.test.ts` (new): migration ordering and lock.
- `work-packages/M20-core-integration-and-release-gate/INTEGRATION_REVIEW.md` (new)
- `work-packages/M20-core-integration-and-release-gate/RELEASE_CHECKLIST.md` (new)
- `work-packages/M20-core-integration-and-release-gate/STATUS.md` (this file)
- `docs/WORK_LOG.md` (appended)

Tests only, under a new test folder; there is no new Nest module, no `app.module.ts` change, no product code change, no dependency, no migration, no `schema.prisma`, `packages/contracts/**`, `ci.yml` or `PROJECT_STATE.md` change.

## Commands and evidence
Run after merging `origin/main` `cd2ab66` with Node 24.22.2 / pnpm 12.16.1, disposable Postgres 18.6 `reelforge-m20-minu-db` on 127.0.0.1:55438 and Redis 7 `reelforge-m20-minu-redis` on 127.0.0.1:56380. Raw output is in ignored `.local-data/m20-*.log` files.

| # | Command | Result |
|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | PASS |
| 2 | `pnpm lint` | PASS |
| 3 | `pnpm format:check` | PASS |
| 4 | `pnpm typecheck` | PASS |
| 5 | `pnpm build` | PASS |
| 6 | `pnpm db:validate` | PASS |
| 7 | `pnpm db:migrate:deploy` on a freshly dropped/created DB | PASS, "27 migrations found", all applied |
| 8 | `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` | 84 lines, byte-identical to the pre-change baseline (no new drift) |
| 9 | `pnpm test` with `DATABASE_URL` + `REDIS_URL` | PASS: 75 files passed / 1 skipped; **514 passed / 5 skipped** (FFmpeg) |
| 10 | `pnpm test` with `DATABASE_URL`, no `REDIS_URL` | PASS: 74 files / 2 skipped; **511 passed / 8 skipped** |
| 11 | `pnpm test` with `FFMPEG_PATH`/`FFPROBE_PATH` set to the main checkout's read-only `.local-tools/` + Redis | PASS after the documented M08 prior-day flake rerun: **518 passed / 1 initial failure**, then the focused 14-test file rerun passed; the M20 release-gate suite passed 11/11. |
| 12 | API smoke on `PORT=3005` | PASS for post-merge health/liveness/readiness (200, database OK), metrics without token (404), unauthenticated `/workspaces` (401), and registration/login (201). Full workspace creation/cross-tenant flow was not rerun because this API uses session cookies rather than a response token; the dedicated HTTP integration suite covers 403/401 tenant behavior. |
| 13 | `pnpm audit --prod` | "No known vulnerabilities found" |
| 14 | `git diff --check origin/main...HEAD` | clean |

The first FFmpeg-enabled post-merge run had the known M08 prior-day flake; the focused 14-test rerun passed. A separate M17 schedule timeout also passed on a focused rerun. The M20 release-gate suite passed 3 files / 11 tests. Earlier audit-table interference was fixed in commit `37c167a` by binding an in-memory audit sink at the test seam.

## Contract/schema proposals
- None applied. Proposed only (Core decisions 5 and 6): registry consumer correction / outbox relay, and an optional drift-reconcile migration `20261119010000_m20_schema_drift_reconcile`.

## Core decisions requested
All are conservative and OPEN; nothing below was implemented.
1. **Release decision:** keep the release **BLOCKED** (`RELEASE_CHECKLIST.md`) until items 2–4 and C1 are resolved. Minu and the owner decide.
2. **T05 live verification:** not authorized. Needs owner sign-off on provider, account/channel, scopes, max spend and attempts, visibility, and cleanup (Gate 4 checklist).
3. **Retention / deletion / export (M19-T07, R14):** needs the retention ADR, including audit retention (triggers block deletes) and a backup procedure. Gate 5 "backup/retention/deletion" stays BLOCKED. No periods invented.
4. **Pending DECISION_LOG items:** AI vendor/model, email sender, production KMS / hosting region. Each blocks its production path.
5. **Event registry (E1–E5):** either remove the unconsumed M14/M16 consumers from `eventRegistry` or implement consumption; decide whether an outbox relay / `published_at` marker and the declared dead-letter queue are required before release; propagate the run correlation id in M13 events; widen `PublishFailed` to all final failures. Owner modules: M00 contracts, M13, M17.
6. **Schema drift (S1–S6):** accept and document, or reconcile with one migration `20261119010000_m20_schema_drift_reconcile`. S1 (M02 active-snapshot FK `SET NULL` vs `RESTRICT`) is the only behavioural item.
7. **C1 paid-call coverage:** require an M08 ledger envelope and M18 reservation for M06 idea proposal, M11 AI quality review and M15 insight LLM before any real adapter is bound to them (extends ADR-018 item 2).
8. **CI dependency-audit step:** approved in principle (ADR-019 item 7); land as a separate `ci.yml` chore PR, not here.
9. **Approval-record caveats:** ratify the six COMMENTED written approvals and the M06 PR #14 → #15 sequence as valid records in the closeout, or require re-review.
10. **Small integration fix (proposed, not made):** scope the M19 `admin.http.integration.test.ts` `audits()` helper to its own workspace ids, so other suites cannot bleed into it (test-only, M19-owned file). Needs written Minu approval.
11. **C2:** map unconfigured M06/M07 LLM errors to a clear NOT_CONFIGURED 4xx/503 instead of HTTP 500.

## Blockers / risks / unknowns
- T05 blocked on owner authorization. Production release blocked on Core decisions 1–4 and 7; Gate 3 duplicate side-effect criterion remains BLOCKED by the M16 crash-retry caveat.
- The end-to-end pipeline is proven only up to the provider boundary plus real FFmpeg rendering of fixture inputs; nothing here is live integration evidence (ADR-007/010).
- The tenant sweep uses empty bodies and random ids for broad route coverage. Separate valid-payload channel create/update checks assert authorization before mutation and verify zero victim-side effects; this does not prove deep authorization for every mutating route.
- Carried residuals: M19 R3, R4, R6–R14; PR #36 N1–N4; M10–M18 residual notes in `PROJECT_STATE.md` (by module in `INTEGRATION_REVIEW.md`).

## Proposed PROJECT_STATE.md change (for the docs-only closeout, not applied)
- Current integrated commit → the M20 merge commit; overall phase → "Phase 1: M00–M20 integrated; release BLOCKED pending owner gates".
- Module index: M20 → INTEGRATED with PR, approved head and merge SHA; blocker "release blocked: T05 not authorized; retention ADR; KMS; AI vendor; email sender".
- Add an "M20 release gate" paragraph linking `INTEGRATION_REVIEW.md` and `RELEASE_CHECKLIST.md`, listing E1–E6, S1–S6, C1–C3.
- Next exact action → owner decisions (Core decisions 2–4) and the Core decisions 5–7/10/11 follow-up PRs.

## Next exact action
Minu compares this branch with the VS Code session's M20 PR and picks one to land (or merges the useful parts: the in-memory audit sink fix and the provider-boundary test). Then the owner answers Core decisions 1–4.

## Handoff notes
Disposable containers `reelforge-m20-minu-db` and `reelforge-m20-minu-redis` were removed; the worktree is left in place. No ports or containers of the main checkout (55437 / 56379 / 3004) or any other project were touched.

## Reviewer decision
- Pending.
