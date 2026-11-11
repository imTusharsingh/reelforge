# M20 Release Checklist (QUALITY_GATES Gate 3, Gate 4, Gate 5)

- **Candidate:** `origin/main` `97dd104413d1107f3d26b85b8dfa3c33d10e5e94` plus the M20 offline release-gate tests on this branch (no product code change).
- **Result legend:** PASS (evidence run this session) / PASS* (pass with a recorded caveat) / FAIL / BLOCKED (waits on an owner or Core decision) / NOT RUN (with reason).
- Findings referenced as E#, S#, C# are in `INTEGRATION_REVIEW.md`.

## Release decision

**NOT RELEASED / BLOCKED.** No CRITICAL code defect was found, but a production release is blocked on:

1. Gate 4 live provider verification: not authorized by the owner (T05).
2. Retention / deletion / export policy and audit retention (M19-T07, R14): retention ADR pending.
3. Production KMS / key delivery and rotation, and hosting region (DECISION_LOG pending item 3).
4. AI provider vendor/model (pending item 1): no AI adapter is bound, so the content pipeline cannot run past the provider boundary; and C1 (M06/M11/M15 AI ports have no M08 ledger / M18 reservation) must be fixed before any of those adapters is bound.
5. Email sender (pending item 2): no live email adapter; email deliveries are `SKIPPED_NOT_CONFIGURED`.

The release decision belongs to Minu (Core) and the owner. This checklist does not declare a release.

## Gate 3 - Integration

| Item | Result | Evidence |
|---|---|---|
| Contract versions match producer and consumer | PASS* | `PostPublished@1` / `PublishFailed@1` match between M13 producer and M17 consumer (release-gate round-trip test). Caveat E1: registry lists M14 / M16 consumers that do not exist. |
| Event payloads validate at both ends | PASS* | Producer validates with the registry schema; persisted rows re-validate in the release-gate test. Caveat E3: M17 runtime does not call `parseRegisteredEvent`. |
| Database migration integrated once and in correct order | PASS | 27 migrations on a fresh DB; `release-gate.migrations.test.ts` enforces unique, increasing timestamps. M20 adds none. |
| Schema matches migrations | PASS* | `migrate diff` shows the same 84-line pre-existing drift as the baseline (S1–S6); no new drift. |
| Cross-module state transitions work | PASS* | Module integration suites (M07→M09→M10→M11→M13→M14→M15/M16/M17/M18/M19) pass offline. End-to-end through real providers is not possible (no adapter bound). |
| Failure and retry paths exercised offline | PASS | Existing module suites (M10 retry/recovery, M13 reconcile, M16 resume/retry, M17 delivery retry, M18 dispatched-vs-not-dispatched). |
| No duplicate publish/generation side effects on retry/restart | **BLOCKED** | M13 outbox and publish attempts are idempotency-keyed, but M16 crash-retry may create a new script/QA/analytics record because BullMQ re-add is not atomic. Per-claim token work and explicit Core acceptance are required before this criterion can pass. |
| Build, lint, typecheck, unit, contract, integration tests pass | PASS | See `STATUS.md` "Commands and evidence". |

## Gate 4 - Live provider verification (T05)

**BLOCKED: not authorized.** Nothing below was run. Before any live call the owner must record, per provider/action:

- [ ] Provider/platform and exact API operation (for example YouTube `videos.insert` unlisted, YouTube Analytics `reports.query`, one AI vendor capability).
- [ ] Account/channel identity and environment (test channel, not the production audience).
- [ ] Exact OAuth scopes / API permissions requested.
- [ ] Expected charge, quota and rate-limit consumption.
- [ ] Maximum spend and maximum number of attempts.
- [ ] Target visibility (private/unlisted) and who can see the result.
- [ ] Cleanup / rollback (delete the test upload, revoke the grant).
- [ ] Operator, exact command, and timestamp (IST).
- [ ] Afterwards: sanitized evidence (no tokens) and the actual result, scoped to that exact capability and account.

## Gate 5 - Release

| Item | Result | Evidence |
|---|---|---|
| Critical/blocking security findings resolved | PASS* | No CRITICAL finding (`INTEGRATION_REVIEW.md` T06). Tenant sweep covers 159 workspace routes and 401 on all without a session; representative valid-payload mutations assert 403 and zero victim-side effects; unscoped routes are a reviewed allowlist. Open HIGH: C1 (gate on binding AI adapters). |
| Budget and rate-limit protections active | PASS* | M18 reservation before paid script / scene-media calls (ADR-018); M16 provider limits per workspace; emergency stop refuses `reservePaidCall`. Caveat C1. |
| Publishing requires approval policy and hard gates | PASS | M13 re-checks M11 approval and all hard gates at publish time (`publishing.service.test.ts` "rechecks approved and rejected reviews through M11 at publish time", "denies scheduling and budget checks rather than fabricating approval"). |
| Emergency pause works | PASS* | M19 `emergency-stop.postgres.integration.test.ts` and `admin.http.integration.test.ts`. Caveats R6 (mid-step stop fails instead of pausing), R10, R13 (GLOBAL env on both processes). |
| Operational dashboard/logs show job and failure state | PASS* | OWNER admin views (failed jobs, queue depth, provider status, recent events, audit log); structured redacted logs; token-gated `/ops/metrics`. Caveats R11 (per-process metrics), N3. API-only, no UI dashboard. |
| Backup/retention/deletion behavior documented | BLOCKED | Retention ADR pending (M19-T07 / R14); audit rows are undeletable by design (R12). No backup procedure is recorded for production. |
| All release notes and project history updated | PASS* | M20 `STATUS.md`, `INTEGRATION_REVIEW.md`, this checklist, and a `WORK_LOG.md` entry. `PROJECT_STATE.md` update is proposed in `STATUS.md` for the docs-only closeout. |
