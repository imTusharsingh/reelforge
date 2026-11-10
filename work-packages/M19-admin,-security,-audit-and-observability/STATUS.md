# M19 Status - Admin, Security, Audit & Observability

- **State:** INTEGRATED (PR #34 squash-merged to `main`; docs-only closeout records it). T07 remains OPEN pending the retention ADR.
- **Assigned session/editor:** Module Implementation Agent, Desktop (TRACXN-LP-784), local session (no cloud agent)
- **Branch/worktree:** `work/m19-admin-security-audit-and-observability`, started from `origin/main` `7e862fe` and merged with `origin/main` `54db53f` (closeout PR #33) using a merge commit (no rebase, no force-push). Main checkout `/home/tracxn-lp-784/Desktop/project/reelforge`.
- **Last updated:** 2026-11-10
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** `e5938e1484972afaf4125f6396646b9fb4483b20` (review `5843747594`, APPROVED by `minu-the-reviewer`)
- **Merged commit:** `3da846e10bc8b682639a32c46bcefc9f529f6e0b` (squash-merged by `minu-the-reviewer` on 2026-11-10)

## Current objective
Provide operational safety, audit history, health checks, and diagnostic visibility.

## Completion estimate
Implemented, reviewed, and integrated via PR #34. T01–T06 and T08 are done; T07 is open pending the retention ADR. The "Core decisions requested" were approved and are recorded as ADR-019.

## Task checklist
- [x] **M19-T01 Security baseline.** See `SECURITY_BASELINE.md` (secrets, RBAC, tenant isolation, input validation, upload controls), which records existing controls and their gaps. The enforced part is a test that walks every controller in `AppModule` and fails on any unguarded route that is not on the public allowlist. M01/M04 were not rewritten.
- [x] **M19-T02 Append-only audit events.** New `audit_events` table with no foreign keys, so history outlives workspace or user deletion. Database triggers reject every `UPDATE`, `DELETE` and `TRUNCATE`, which is tighter than M18's trigger because there is no cascade path. A global `HttpAuditInterceptor` records every mutating route (POST/PUT/PATCH/DELETE) plus the OAuth callback GET:
  - Each record holds category, action (`METHOD /route/template`), outcome (`SUCCESS`/`FAILURE`/`DENIED`), HTTP status, actor, workspace, UUID-only route target ids, `resultId` for creates, correlation id and trace id.
  - Categories: AUTH, CONFIG, APPROVAL, CONNECTION, PUBLISHING, ADMIN, OPERATION.
  - Request bodies, query strings and emails are never stored.
  - Emergency-stop changes write their own ADMIN record with `before`/`after` and the reason, and that route skips the HTTP record so nothing is duplicated.
  - A failed audit write is logged and counted in metrics but never fails the user's request.
  - The audit log is read with `GET /workspaces/:id/admin/audit-events?category=&limit=&before=`, OWNER only.
- [x] **M19-T03 Structured logs, correlation ids, metrics, traces, redaction.** `packages/observability` (M00 stub, owned by M19) has no third-party dependencies:
  - JSON-line `StructuredLogger`, plus a Nest `LoggerService` adapter that the API (`NestFactory.create({ logger })`) and the worker (`Logger.overrideLogger`) install at bootstrap. `console.*` is also routed through redaction. `LOG_LEVEL` sets the level.
  - AsyncLocalStorage request context: the existing UUID correlation-id scheme (`x-correlation-id` is accepted only as a UUID, otherwise replaced) and W3C `traceparent` in and out.
  - In-process Prometheus-text `MetricsRegistry` with counters, gauges and histograms, sanitized labels and route templates only. Exposed at `GET /api/v1/ops/metrics`, which returns 404 unless `OPS_METRICS_TOKEN` (16 characters or more) is set and the request sends it as a Bearer token. The comparison is timing-safe.
  - OTel-shaped spans (`startSpan`/`withSpan`) with a pluggable exporter, so no SDK is needed.
  - Redaction rules are listed in `SECURITY_BASELINE.md`. Every URL is reduced to `scheme://host/[REDACTED]`, so private media URLs are not logged.
  - The access log records method, route template, status, duration, user id, correlation and trace. It never logs the raw URL, body or headers.
- [x] **M19-T04 Readiness/liveness.**
  - The existing `GET /health` was extended (no new route): `{status, queue, database}`. `database` comes from `SELECT 1` with a 2 s timeout; status is `degraded` if the queue or the database is down. The response is still HTTP 200, as before.
  - `?probe=liveness` checks no dependencies.
  - `?probe=readiness` returns 503 only when Postgres is unreachable. An unconfigured queue stays `NOT_CONFIGURED` and does not fail readiness.
  - No provider, Redis job or ledger work is done. A test records every database call the app makes during the three probes: the result is exactly two `$queryRaw` calls, and `fetch` is never called.
- [x] **M19-T05 Admin views** (API only, OWNER only, workspace-scoped) under `/api/v1/workspaces/:workspaceId/admin`:
  - `failed-jobs`: failed or reconciliation-required workflow runs, steps and jobs, render jobs, scene-media jobs, publishing destinations, metric collection jobs and notification deliveries, with counts. Error messages are redacted.
  - `queue`: the M16 queue adapter state, plus Postgres status counts for workflow steps and jobs, render, scene media, metrics, deliveries and destinations.
  - `providers`: 24 h M08 ledger stats by provider and capability, plus M12 social account health. No live checks are made.
  - `events`: recent workflow events, M12 account events and audit events.
- [x] **M19-T06 Emergency stop.** There are three scopes:
  - GLOBAL: operator env `REELFORGE_EMERGENCY_STOP=1|true|yes|on`, with an optional `REELFORGE_EMERGENCY_STOP_REASON`.
  - WORKSPACE and CHANNEL: set and cleared by the OWNER through `PUT admin/emergency-stop` with `{scope, channelId?, active, reason, expectedVersion?}`. The reason is required and the version supports optimistic concurrency. Any member can read the stop with `GET admin/emergency-stop`.

  While a stop is active:
  - The M16 budget policy (M19 decorator in front of the M18 adapter) answers `BLOCKED/EMERGENCY_STOP`. Manual runs get 409 and scheduled slots are `SKIPPED/EMERGENCY_STOP`.
  - `processJob` pauses a run at the next step boundary, using the existing `PAUSED` state with `pausedReason EMERGENCY_STOP`. The step is not claimed or dispatched. Resume returns 409 until the stop is cleared.
  - M18 `reservePaidCall` refuses before any reservation, so no M08 provider call is made.
  - The M13 publish/retry preflight fails.

  Safe reconciliation keeps working: `WAITING_EXTERNAL` polls of work that already exists, M13 reconcile, recovery sweeps and every read.

  It composes with the M16 channel pause and does not replace it. No state was added to the M16 machine.
- [ ] **M19-T07 Retention, deletion and export: BLOCKED on the ADR** (see below). No retention periods, purge jobs or export endpoints were built.
- [x] **M19-T08 Security review checklist and scanning.** See `SECURITY_REVIEW_CHECKLIST.md`. `pnpm audit` was run locally (results below). `ci.yml` was not edited; the proposed CI step is in the checklist.

## Acceptance evidence
| Criterion | Evidence |
| --- | --- |
| Secrets and private media URLs are absent from logs | `observability.test.ts` (11 tests): key-based and pattern redaction, URL reduction, error serialization, console patching, and JSON logger output with a signed URL, Bearer token and password. Access log uses route templates only (`request-context.middleware.ts`). Audit rows checked to contain no password, email, session cookie or OAuth code (`admin.http.integration.test.ts`). Failed-job view checked to strip `X-Goog-Signature` and `ya29.` |
| Health checks make no provider calls or charges | `health.controller.test.ts` (3 unit tests) and the HTTP test above: only `SELECT 1`, no `fetch` |
| Critical user actions are auditable | HTTP test covers AUTH (register, failed login `DENIED`, login, logout, with actor and correlation id), CONFIG (success, plus a VIEWER `DENIED` with that actor), APPROVAL, CONNECTION (revoke and OAuth callback), PUBLISHING, and ADMIN (stop set and clear). `audit.catalog.test.ts` checks route classification. The append-only test shows `UPDATE`, `DELETE` and `TRUNCATE` all rejected |
| Emergency stop blocks new side effects but allows reconciliation | `emergency-stop.postgres.integration.test.ts` (6 tests): OWNER-only set and clear with audit and CAS; cross-tenant channel 404; manual 409; queued step `PAUSED/EMERGENCY_STOP` with zero dispatches; resume 409 until cleared; `WAITING_EXTERNAL` poll continues; scheduled slot `SKIPPED/EMERGENCY_STOP`; paid call refused with no reservation; publish preflight fails; GLOBAL env applies to every workspace. HTTP test covers PUT/GET and manual run 409 |
| Auth and workspace scoping, with cross-tenant denial | Admin routes: 401 unauthenticated, 403 for EDITOR, VIEWER and other-workspace OWNER, 200 for OWNER. Failed-job and audit lists never include another tenant. Guard-coverage test |

## Files changed
- **New package code** (`packages/observability/src/`): `redaction.ts`, `context.ts`, `logger.ts`, `metrics.ts`, `tracing.ts`, `bootstrap.ts`, `index.ts`, `observability.test.ts`. Also `packages/observability/package.json` (types now point at `src` like `@reelforge/database`, plus devDependency `@types/node` 24.19.2, the root's pin) and `tsconfig.json` (`types: ["node"]`).
- **New API module** (`apps/api/src/modules/admin/`): `audit.{types,catalog,service,module,interceptor}.ts`, `emergency-stop.{types,service,module,adapters}.ts`, `request-context.middleware.ts`, `admin.{service,controller,module}.ts` and `ops-metrics.controller.ts`. Tests: `audit.catalog.test.ts`, `emergency-stop.postgres.integration.test.ts`, `admin.http.integration.test.ts`.
- **Schema and migration (approval requested):**
  - `schema.prisma`: the diff is additive. It appends enums `AuditCategory`, `AuditOutcome` and `EmergencyStopScope` and models `AuditEvent` and `EmergencyStop`, and adds one `emergencyStops` back-relation line each to `Workspace` and `Channel`.
  - Migration `20261118010000_m19_admin_security_audit_observability`: tables, indexes, composite FKs, CHECK constraints (scope/channel consistency, non-empty reason), and the `prevent_audit_event_change()` row and TRUNCATE triggers.
  - `packages/database/src/index.ts` exports the three enums.
- **Shared and cross-module edits (approval requested):**
  - `app.module.ts`: adds `AdminModule`.
  - `orchestration.module.ts`: `WORKFLOW_BUDGET_POLICY` becomes the M19 decorator wrapping `UsageBudgetPolicy`.
  - `orchestration.service.ts`: adds an optional `EMERGENCY_STOP_PORT` constructor parameter, the step-boundary emergency pause, and the resume guard.
  - `usage-budget.{module,service}.ts`: adds an optional stop port; `reservePaidCall` refuses during a stop.
  - `publishing.module.ts`: the schedule port is wrapped by the stop.
  - `health.controller.ts` and its test.
  - `apps/api/src/main.ts` and `apps/worker/src/main.ts`: observability bootstrap.
  - `apps/{api,worker}/package.json`: `@reelforge/observability: workspace:*`.
  - `pnpm-lock.yaml`: the workspace links plus that `@types/node` entry; no new external package.
  - `vitest.config.ts`: alias for `@reelforge/observability`, matching the other workspace packages.
- **Docs:** this file, `SECURITY_BASELINE.md`, `SECURITY_REVIEW_CHECKLIST.md`, `docs/WORK_LOG.md`. `PROJECT_STATE.md` and `ci.yml` are untouched.

## Core decisions requested
These are conservative choices, implemented so they can be reviewed. Each needs Minu's written approval.
1. **Schema and registration.** Additive models plus migration `20261118010000_m19_admin_security_audit_observability` (the recommended name). `AdminModule` is registered in `app.module.ts`. No applied migration was touched.
2. **What "admin" means.** It is the workspace **OWNER** (ADR-003); no new role and no platform-operator role, so no ADR is needed. The only platform-wide control is the GLOBAL stop, which is operator-controlled through an environment variable and cannot be set over HTTP.
3. **Emergency stop.** Scopes are GLOBAL (env), WORKSPACE and CHANNEL (OWNER). It composes with M16 through the `BudgetPolicyPort` decorator, plus one step-boundary check in `processJob` that reuses `PAUSED` and `pausedReason`; no M16 state was added.
   - Not blocked:
     - `WAITING_EXTERNAL` polls (they reconcile work that already exists).
     - M13 reconcile.
     - Sweeps.
     - Analytics metric collection (read-only provider reads).
     - Social OAuth connect.
   - Flag: if Core wants analytics reads or OAuth blocked too, each is a one-line port check.
   - Workspace deletion cascades to its stops.
4. **Audit sink.** An M19-owned shared append-only table, fed by one global HTTP interceptor, so no other module's service changed. Other modules can also call `AuditService.record` for non-HTTP actions. M18's `usage_audit_records` is untouched.
   - Not audited:
     - Guard-level 401 denials (no route context; M01 `auth_events` already covers login and session failures).
     - Reads.
     - Worker-initiated actions.
   - Flag: whether Core wants worker/system actions audited as well.
5. **Observability stack.** No new dependency. The OTel SDK and exporters are deferred to a future ADR-012 pin, and spans use OTel field names so that switch is mechanical.
   - `/ops/metrics` is off by default and token-gated. Flag: approval for this route, which is on the public allowlist because its auth is the operator token.
   - The request-context middleware is bound to every route with the named wildcard `{*path}` (path-to-regexp v8).
6. **Health.** It stays on `/health`, with `probe=liveness|readiness` query modes rather than new routes. Readiness gates on Postgres only. Plain `/health` keeps returning 200 with `degraded`, matching existing behaviour.
7. **Admin views.** API only and OWNER only. They read other modules' tables directly through Prisma, as M17 intake does, without calling their services.
8. **Retention, deletion and export.** Blocked on the ADR (below).
9. **Scanning.** `ci.yml` was not changed. Proposed step: `pnpm audit --prod --audit-level high`.

## T07 blocker (retention / deletion / export)
`docs/DECISION_LOG.md` "Pending decisions" #4 (data-retention durations) and #3 (production KMS) are still open, and the task says not to invent periods. So no purge job, TTL, export endpoint, or credential-deletion policy shipped. What exists today, for the ADR author:
- Credentials: tokens are AES-256-GCM encrypted at rest (`token-vault.ts`). M12 revoke calls the provider's revoke and then deletes the stored token rows, and workspace deletion cascades to tenant data. None of this is new in M19.
- `audit_events` is permanent by design: the trigger rejects DELETE/TRUNCATE, and there are no FKs, so it survives workspace deletion. Any retention rule for audit rows therefore needs a later migration that replaces the trigger with a retention-aware rule, and that has to be decided in the same ADR.
- `emergency_stops` cascades with its workspace.
- The ADR needs decisions on: media and render artifact retention, analytics snapshot retention, audit retention, export format and scope, and deletion SLAs.

## Commands and evidence
Run on the Desktop machine with Node 24.22.2 and pnpm 12.16.1. Environment: `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55437/reelforge` (disposable `reelforge-m19-db`, postgres:18.6-alpine) and `REDIS_URL=redis://127.0.0.1:56379` (disposable `reelforge-m19-redis`).

Results:
- `pnpm install --frozen-lockfile`: passed.
- `pnpm lint`: passed.
- `pnpm format:check`: passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `pnpm db:validate`: passed ("The schema at prisma/schema.prisma is valid").
- `pnpm db:migrate:deploy` on a fresh database (`reelforge_fresh` on 55437): passed; "27 migrations found", all applied, with `20261118010000_m19…` applied last.
- `prisma migrate diff` (fresh DB to schema): no line mentions `audit_events`, `emergency_stops` or the M19 enums. The remaining lines are earlier modules' FK/index-name and default drift, the same drift listed in M18 STATUS.
- `pnpm test` with `REDIS_URL`: **72 files passed / 1 skipped; 497 tests passed / 5 skipped** (the 5 FFmpeg skips). Green in all three full runs.
- `pnpm test` without `REDIS_URL`: 71 files passed / 2 skipped; 494 passed / 8 skipped (5 FFmpeg + 3 Redis). One of the three runs hit the known M08 25 ms flake (`script.integration.test.ts`, prior-day reset; not touched by M19), and the rerun was green.
- M19 alone (`vitest run apps/api/src/modules/admin packages/observability apps/api/src/health.controller.test.ts`): 32 tests (11 observability, 3 health, 3 catalog, 6 emergency stop on Postgres, 9 HTTP).
- `pnpm audit --prod`: "No known vulnerabilities found".
- `pnpm audit` (all deps): 1 moderate, `minimatch` <11.0.1 (GHSA-g3hv-75wg-m249), dev-only through eslint and typescript-eslint. Not fixed here: it needs a dev-toolchain upgrade, which belongs to a root-config owner.
- API smoke on `PORT=3004`: built API, real Postgres and Redis. Results:
  - `/health` returns 200 `{status: ok, queue: CONFIGURED, database: OK}` and echoes the sent `x-correlation-id` plus a `traceparent`.
  - Liveness and readiness both return 200.
  - `/ops/metrics` returns a JSON 404 without the token, and 200 `text/plain` Prometheus output with it.
  - Register returns 201; creating a workspace and then `PUT admin/emergency-stop` returns 200.
  - `audit-events` lists `ADMIN EMERGENCY_STOP_SET` and `CONFIG POST /workspaces`.
  - The four admin views return 200; unauthenticated access returns 401.
  - The log has no password or session cookie, and no warning lines remain. The smoke caught the Nest `"*"` wildcard warning and a content-type warning on the metrics 404, and both are fixed.

## Blockers / risks / unknowns
- T07 is blocked on the retention ADR (above).
- `audit_events` cannot be cleaned up by tests or support tooling. Test rows stay in disposable databases, which is intentional.
- The HTTP audit records attempts at the route level. For a success, the target is the route's UUIDs plus `resultId`, not domain-level before/after (only emergency-stop records carry before/after). Domain-level diffs for config changes would need per-module calls to `AuditService.record` (a cross-module change, not done).
- Metrics are per process and in memory; they reset on restart and are not aggregated across workers. Spans are not exported anywhere unless an exporter is set.
- The worker boots its own `AppModule` (existing pattern). The emergency-stop checks therefore also run in worker job processing; the stop is read from Postgres, so the API and worker agree.

## Next exact action
None for M19 product work except T07, which waits for the retention ADR. M20 is next after the docs-only closeout merges.

## Handoff notes
- Owner-side env vars: `REELFORGE_EMERGENCY_STOP`, `REELFORGE_EMERGENCY_STOP_REASON`, `OPS_METRICS_TOKEN`, `LOG_LEVEL`.

## Reviewer decision
- APPROVED at `e5938e1484972afaf4125f6396646b9fb4483b20` (review `5843747594`), no blockers. Core decisions approved and recorded as ADR-019.
- Integration: squash-merged to `main` by `minu-the-reviewer` at `3da846e10bc8b682639a32c46bcefc9f529f6e0b` (PR #34) on 2026-11-10. State set to INTEGRATED by the docs-only closeout PR; no product rework.

## Carried residual notes (non-blocking)
- R1: JSON- and YAML-style secrets (`"access_token": "…"`) are not masked (`packages/observability/src/redaction.ts:65-66`).
- R2: `uncaughtException` / `unhandledRejection` output bypasses the redacting logger.
- R3: Prisma validation errors can print argument values.
- R4: non-URL local file paths are not masked.
- R5: the `/ops/metrics` token compare leaks the token length; compare SHA-256 digests instead.
- R6: an emergency stop raised mid-step fails the run instead of pausing it.
- R7: the manual-run 409 during an emergency stop says 'Budget policy blocked'.
- R8: the audit write is not transactional with the action, and redirects are recorded as 200.
- R9: audit paging (`before=`) skips rows with equal timestamps.
- R10: a simultaneous first-time emergency stop on the same scope returns 500.
- R11: metrics are in-memory and per process.
- R12: `audit_events` rows are undeletable (intentional).
- R13: the GLOBAL stop env var must be set on both the API and the worker.
- R14 / T07: retention, deletion and export are OPEN pending the retention ADR; that ADR must also cover audit retention, because the trigger blocks deletes.
