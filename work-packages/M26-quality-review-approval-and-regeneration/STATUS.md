# M26 Status - Quality Review, Approval & Regeneration

- **State:** INTEGRATED (existing main merge via PR #68; documentation reconciliation only)
- **Assigned session/editor:** Codex implementation session
- **Branch/worktree:** `feat/m26-quality-review-ui`, `/workspace/reelforge`
- **Last updated:** 2026-11-13
- **Reviewer:** `minu-the-reviewer` / Core Architect
- **Approved commit:** none; independent review required

## Completed implementation

- [x] **M26-T01:** Authenticated `/review` queue and `/review/runs/[runId]`, enabled shell navigation, pending-only scope, oldest-first position, loading/empty/error/retry, render context, pinned scenes and authenticated preview.
- [x] **M26-T02:** All eleven deterministic hard gates, recorded evidence, missing-evidence states, policy snapshot, disclosures and limitations.
- [x] **M26-T03:** Complete persisted AI scorecard validation, five criteria, evidence/limitations, model/prompt provenance; distinct unavailable, manual, deterministic and automatic approval states.
- [x] **M26-T04:** Owner/Editor decisions, Viewer read-only, explicit required reason, target/scene/override validation, confirmation, duplicate protection, conflicts and GET-only reconciliation before another decision.
- [x] **M26-T05:** Persisted decision action/reason/override/reviewer ID/time and regeneration stage/scene/attempt/time. No invented names or historical discovery.
- [x] **M26-T06:** Safe links to existing planning script, production job and persisted render detail/retry workflows. Recording a change request does not dispatch provider work. M25 safeguards are untouched.
- [x] **M26-T07:** Separate current-render quality status read, complete hard-gate evidence and blockers; advisory eligibility with authoritative publishing rechecks explained.

## Files changed

- `apps/web/app/review/layout.tsx`, `page.tsx`, `runs/[runId]/page.tsx`: authenticated routes and workspace scope.
- `apps/web/features/review/model.ts`: validated local DTOs, gates, policy, scorecard, decision rules, readiness and routing.
- `apps/web/features/review/api.ts`: cookie-authenticated scoped requests, response identity checks, permission/duplicate guards and persistent uncertain-write recovery.
- `apps/web/features/review/session.tsx`: workspace/role keyed scope, abort and late-response guards, read states.
- `apps/web/features/review/workspace.tsx`, `review.module.css`: queue, evidence/detail, preview, decisions, recovery, history and responsive layouts using shared primitives/tokens.
- `apps/web/features/review/model.test.ts`, `api.test.ts`: focused model/API tests.
- `apps/web/features/review/verification/{fixtures.ts,mounted-fixture.tsx,mounted-browser.mjs,README.md}`: isolated browser fixtures and repeatable verification.
- `apps/web/components/app-shell.tsx`: Review navigation/current-page semantics and Review/Production breadcrumbs.
- `apps/web/features/production/render.tsx`: return link to the quality review queue.
- This status and `docs/WORK_LOG.md`: implementation record and handoff.

## Commands and actual evidence

- Fetched latest `main` and existing M26 branch; switched to the named implementation branch and ran `git merge origin/main` (already up to date). Preserved pre-existing handoff commit `eb7a3be` atop M25 `fd86925`.
- Read Issue #67 via GitHub, complete work package, M11 service/controller/validation/types, M24/M25 UI/API/browser patterns, design system, decision log and architecture/governance documents.
- `pnpm install --frozen-lockfile`: passed; pinned dependencies unchanged.
- `bash /workspace/environment/reelforge/start-postgres.sh`: local PostgreSQL ready. `pnpm db:migrate:deploy`: passed, 30 existing migrations present; applied only three outstanding M24/M25 migrations to the disposable development database.
- `pnpm exec vitest run apps/web/features/review`: passed, 44 tests in 2 files.
- `pnpm --filter @reelforge/web typecheck`: passed.
- `pnpm typecheck`, `pnpm lint`, `NODE_ENV=production pnpm build`: passed in initial full verification. Final rerun recorded below when complete.
- `NODE_ENV=test pnpm test`: initial full run passed, 97 files passed / 2 skipped, 741 tests passed / 8 skipped. Two additional recovery-storage tests were added afterward; final result recorded below.
- Mounted Chromium command documented in `apps/web/features/review/verification/README.md`: 17 scenarios passed, including delayed old-workspace response after a scope switch, queue loading/retry, Owner approval, Editor change request, Viewer restrictions, missing/failed gates, scorecard/automatic approval, persisted history, 409/ambiguous response read reconciliation, scene validation, valid local video and expired media, keyboard focus and 390px/1440px overflow.
- Screenshots: generated `work/m26-review-390.png` and `work/m26-review-1440.png`; inspected the mobile capture. The harness serves real repository brand SVGs and shared CSS; fixtures are visibly labelled. Screenshots can be regenerated with the documented command and are not production data.
- Initial focused test failed because the reused M25 fixture omitted source context; corrected the M26 fixture. Initial lint found two missing cleanup return annotations; corrected. Initial browser bundle referenced a nonexistent shim; reused the existing M25 shim. Subsequent focused/lint/browser checks passed.
- No paid AI or social calls were made. Media verification generated a one-second local FFmpeg video. Browser-only esbuild was installed under ignored `work/browser`, without manifest/lockfile changes.

## Security, contract limitations and remaining risks

- Quality DTOs do not include workspace identity. Requests are workspace-scoped and authenticated; unexpected workspace identity is rejected when present. The M25 render DTO must match both workspace and requested render ID. Quality run/status identities are checked. React escapes displayed persisted evidence.
- Owner/Editor checks supplement authoritative backend authorization. Failed, missing or evidence-free hard gates cannot be approved in this UI. No score or override reason can unlock approval or publishing.
- A per-workspace/run session-storage marker is written before POST; interrupted, invalid, unconfirmed or rejected responses require fetching persisted state and explicit comparison. No automatic mutation replay. Browser-storage failure prevents dispatch. Reload/scope changes preserve recovery markers without storing decision text. Backend transactions remain the final cross-tab/concurrent-review safeguard.
- Queue is bounded to 50 current pending reviews; there is no public history-list endpoint. Known review URLs retain run-level history. A future full archive would need a Core-approved workspace-scoped paginated quality-run listing; this is not simulated.
- No quality provider-availability read contract exists. `POST /quality/runs` may execute AI review, so this milestone exposes no speculative evaluation/re-evaluation action. Displayed AI results come only from valid persisted scorecards.
- Rights/disclosure route matching depends on backend asset-pair evidence. Where this UI cannot prove a matching failed-gate route, it conservatively requires an explicit regeneration override reason. The backend validates the route, pinned scene, current state and lineage attempt limit (three) and may still reject it. An override explains the target and cannot bypass a hard gate.
- Regeneration history is a request record, not generated-media proof. Existing Production/Planning workflows retain capability, cost, idempotency and observed-version controls. No unsupported asset assignment was added.
- Current render status is an advisory quality signal, not a full publishing authorization. Publishing revalidates latest review, current policy and provenance on the server.
- Local PostgreSQL is 17.11; CI uses 18.6. Eight optional integration tests skip without the separate Redis/FFmpeg test configuration. Mounted browser scenarios use controlled API responses; they are not live-provider or complete deployed-auth evidence.
- No shared contracts, backend files, root tooling, database schemas or migrations changed. No Core contract change is needed for the supported M26 scope.

## Final verification

All final commands exited 0:

| Command | Actual result |
| --- | --- |
| `pnpm format:check` | PASS (rechecked after documentation and local evidence formatting) |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS, all workspace packages |
| `NODE_ENV=test pnpm test` | PASS, 97 files passed / 2 skipped; 745 tests passed / 8 skipped |
| `NODE_ENV=production pnpm build` | PASS, including both new review routes |
| `pnpm db:validate` | PASS |
| `pnpm db:check-migrations` | PASS, 30 existing migrations |
| `pnpm security:secrets` | PASS; repeated after staging to include new files |
| `git diff --check` | PASS |

The final format recheck initially found only the generated local `work/final-checks.json` missing a trailing newline; formatting that ignored evidence file resolved it without a tracked tooling change. Latest browser rerun: 20/20 passed; focused review tests: 44/44 passed. A final trust-boundary follow-up mirrors M11 strict scorecard fields and evidence/provenance bounds, with a regression test. Lint, format, typecheck, the full PostgreSQL suite, mounted browser scenarios and production build were re-executed after the follow-up. Implementation is complete within the existing contracts. Remaining work is independent review and CI confirmation; no self-approval or merge.

## Next action and reviewer decision

[PR #68](https://github.com/imTusharsingh/reelforge/pull/68) targets `main`, includes `Closes #67`, and remains unmerged. The independent review requested the RENDER-route correction documented below; that blocker and the nonblocking queue wording note are now fixed and locally verified. Hosted CI passed on the previously reviewed head `c4148d3` (run 43182925922). Next: push the follow-up, post the verification summary, request `minu-the-reviewer` re-review, and monitor CI on the follow-up commit. Independent approval is still required; do not self-approve or merge.


## PR #68 independent review follow-up

Addressed the [changes-requested review](https://github.com/imTusharsingh/reelforge/pull/68#pullrequestreview-5872848055) from `minu-the-reviewer`:

- **R1 / M26-T06 blocker:** `RENDER` requests now link to `/production/renders/:renderJobId` using the persisted render ID. They no longer link to scene-production creation, and routing remains available without script input context. History explains that successful renders cannot be retried and that creating a new render from a review request is unsupported. Existing backend/M25 retry rules, permission checks and idempotency remain unchanged; navigation does not dispatch generation.
- **Nonblocking wording note / #64:** Null scorecards now read “No AI scorecard recorded” unless persisted status is explicitly `AI_REVIEW_UNAVAILABLE`. Valid recorded scorecards retain their existing label.
- Changed files for this follow-up: review `model.ts`, `model.test.ts`, `workspace.tsx`, browser `mounted-fixture.tsx`, `mounted-browser.mjs`, verification `README.md`, this status and the appended work-log record.
- Focused model/API suite: 44 tests passed. Mounted Chromium: 20 scenarios passed, including exact persisted-render routing, missing-script-context/path encoding, successful-render limitation messaging, no generation POST, and distinct missing/unavailable queue wording. Existing desktop/390px, role, evidence and reconciliation scenarios remain passing.
- Full repository verification after the review fixes passed: `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `NODE_ENV=test pnpm test` (745 passed / 8 skipped; 97 files passed / 2 skipped), `NODE_ENV=production pnpm build`, `pnpm db:validate`, `pnpm db:check-migrations` (30 immutable ordered migrations), `pnpm security:secrets`, and `git diff --check` all exited 0. The local PostgreSQL readiness check passed. No paid/provider calls or backend/shared-contract/tooling changes. Independent re-review is still required. No self-approval or merge.

## Main closeout — 2026-11-13 (#80)

- Existing integration: [PR #68](https://github.com/imTusharsingh/reelforge/pull/68), head `bc2e94a5e9729e2eca387ec58fbfbfe8962829da`, merge `351a101439d6e61eb5a16df8f7f3a895b1f1e843`. This records an existing merge; it grants no new review, approval, live-call or release authorization.
- Current scope/gaps: Quality review, approval and regeneration UI is merged. Missing/unconfigured AI quality adapters remain explicit; #79 adds cross-flow browser/axe coverage.
- Earlier pending-review/next-action text above is historical evidence, superseded for merge state by this closeout. Earlier verification commands remain the original session's results; this documentation task does not rerun or upgrade them.
- Next action: keep release risks explicit, complete #78/#79 in their own assigned PRs, and submit this docs-only closeout for Minu review.
