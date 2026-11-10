# M16 Status - Workflow Orchestration & Scheduler

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Module Implementation Agent, Desktop (TRACXN-LP-784); started in an opencode session that stopped at a usage limit, finished locally in the same checkout
- **Branch/worktree:** `work/m16-workflow-orchestration-and-scheduler` from `origin/main` `727140ce025b9691aca1f0999c889983c5b8d32d`; main checkout, no worktree
- **Last updated:** 2026-11-10
- **Reviewer:** Core Architect/Reviewer (Minu)
- **Approved commit:** none

## Current objective
Coordinate durable jobs, schedules, dependencies, pause/resume, retries, and run history.

## Completion estimate
~97% (estimate only, not an approval). Review REQUEST_CHANGES 5838818072 (B1–B6 plus the cheap residuals) is addressed in fix-forward commits on top of `0c6b941`; awaiting re-review.

## Task checklist
- [x] M16-T01: Run/step/job state machines (`orchestration.state.ts`); every transition is an `updateMany` compare-and-swap on the expected status, and a failed CAS is a 409 or a no-op.
- [x] M16-T02: `WorkflowQueuePort` with a BullMQ 6.6.0 adapter, an in-memory adapter, and a NOT_CONFIGURED adapter. Job ids are deterministic (`run.step.retryGeneration.attempt`). Attempts, exponential backoff, and dead letter (`workflow_jobs.status = DEAD_LETTER`, `dead_lettered_at`) are persisted in Postgres.
- [x] M16-T03: Channel schedule evaluation in the channel's IANA timezone (DST gap skipped, fall-back ambiguity yields one slot). Slots are claimed through a unique `(workspace, channel, slotKey)`. Paused or archived channels get a SKIPPED slot. The budget port defaults to NOT_CONFIGURED, so a scheduled slot is SKIPPED with `BUDGET_POLICY_UNAVAILABLE` and no run is created (nothing counts toward `maxRunsPerDay`). Approval waits are visible.
- [x] M16-T04: Manual and scheduled runs share `createRun`, the definition, and the state machine.
- [x] M16-T05: GENERATION: VERIFY_CONTEXT → SELECT_IDEA (M06) → GENERATE_SCRIPT (M07) → GENERATE_SCENE_MEDIA (M09) → COMPOSE_RENDER (M10) → QUALITY_REVIEW (M11, waits for human approval).
- [x] M16-T06: PUBLISH: VERIFY_CONTEXT → PUBLISH (M13 `publishNow`, all M13 gates) → ANALYTICS_FOLLOW_UP (M14 `scheduleCollection`). ANALYTICS is a standalone follow-up.
- [x] M16-T07: Inspect, list, cancel, retry-from-failed-step, and resume, all CAS-safe. Resume after approval re-reads the M11 review. Resume of a scheduled run re-evaluates the budget policy.
- [x] M16-T08: The correlation id is stored on the run, sent in every job payload and dispatch call, and written on every event. Step events also record `stepId` and the `workflow_jobs` row id.
- [x] M16-T09: Postgres slot leases per WORKSPACE, CHANNEL, PROVIDER, and JOB_TYPE (`workflow_limit_leases`), plus a per-minute rate counter (`workflow_rate_counters`).

## Files changed
- Schema/migration (Core-approved additive): `packages/database/prisma/schema.prisma` (9 enums, extended `WorkflowRun`, new `WorkflowStep`, `WorkflowJob`, `WorkflowEvent`, `WorkflowScheduleSlot`, `WorkflowSchedulerCursor`, `WorkflowLimitLease`, `WorkflowRateCounter`, all with composite tenant FKs); `packages/database/prisma/migrations/20261114010000_m16_workflow_orchestration/migration.sql`; `packages/database/src/index.ts` (enum exports).
- API module: `apps/api/src/modules/orchestration/` (`orchestration.{types,state,definitions,queue,bullmq,budget,limits,schedule,time,validation,dispatcher,service,controller,module}.ts`).
- Tests: `orchestration.{state,time,schedule,service}.test.ts`, `orchestration.postgres.integration.test.ts`, `orchestration.bullmq.redis.integration.test.ts`.
- Registration: `apps/api/src/app.module.ts` (`OrchestrationModule`).
- Worker entry points, following the existing `asset.service.ts`/`composition.service.ts` root re-export pattern so the worker can import them: `apps/api/src/app-module.ts`, `apps/api/src/orchestration-service.ts`, `apps/api/src/orchestration-queue.ts`, `apps/api/package.json` (exports, plus `bullmq` 6.6.0 at the same pin as the worker), `pnpm-lock.yaml` (that importer entry only).
- Worker: `apps/worker/src/handlers/orchestration/{factory,consumer,handler}.ts`, `apps/worker/src/main.ts` (composition poller kept, orchestration tick added, shared SIGINT/SIGTERM shutdown), `apps/worker/tsconfig.json` (paths).
- Other modules: one additive read, `ChannelService.listSchedulerCandidates()`. No other module behavior or schema changed.
- Docs: this file, `docs/WORK_LOG.md`. `PROJECT_STATE.md` is untouched.

## API
`/workspaces/:workspaceId/orchestration/runs`: `POST` (start manual), `GET` (list), `GET :runId` (inspect: state, steps, jobs, events, failures, retries, nextAction), `POST :runId/cancel`, `POST :runId/retry`, `POST :runId/resume`. OWNER/EDITOR can write. VIEWER is read-only (403 on writes). Everything is workspace-scoped, and other tenants get 404.

## Review fixes for REQUEST_CHANGES 5838818072 (fix-forward, no amend/force-push)
- **B1 Redis client / fail loud.** `ioredis` pinned at exactly `5.11.1` in `apps/api` and `apps/worker` (the only new dependency; bullmq resolves as `6.6.0(ioredis@5.11.1)`). `createWorkflowQueueFromEnv` (`orchestration.bullmq.ts`): unset `REDIS_URL` → NOT_CONFIGURED; set → always `BullMqWorkflowQueue` (a malformed URL throws at startup). The `redisClientAvailable()` fallback is removed everywhere. `WorkflowQueuePort.health()` returns CONFIGURED / NOT_CONFIGURED / UNREACHABLE (connect + round-trip with a 5 s timeout); enqueue also has a 5 s timeout, so a down Redis throws instead of hanging. `GET /health` (`health.controller.ts`) now returns `{ status: "ok" | "degraded", queue }`. The worker (`apps/worker/src/handlers/orchestration/factory.ts`) refuses to start when `REDIS_URL` is set and the queue is not CONFIGURED, and waits at most 10 s for BullMQ readiness (`handler.ts`). The Redis suite skips only when `REDIS_URL`/`DATABASE_URL` is unset.
- **B2 lease fencing.** The claim records `leaseOwner = workerId` and CASes on the observed `attempts`, `retryGeneration`, `limitWaits`, `externalPolls`, lease, and `nextAttemptAt`. Every later RUNNING→* write (success, approval wait, external wait, limit wait, retry, fail, reconciliation) is fenced by `{ status: RUNNING, leaseOwner: workerId, attempts }` (`orchestration.service.ts` `guard`). A heartbeat (`startHeartbeat`, every `heartbeatIntervalMs` = 20 s, TTL 60 s) renews the lease during `dispatchStep` and is cleared in `finally`. Only the job id the step currently expects may claim it; older deliveries return `superseded job`. Stale-lease recovery also CASes on owner and attempts.
- **B3 waiting on external work.** New step state `WAITING_EXTERNAL` (additive migration `20261115010000_m16_orchestration_hardening`: enum value plus `limit_waits`, `external_polls`, `external_deadline_at`). A dispatcher result with `waitingExternal` parks the step, merges its output into the run input in the same transaction (so `sceneMediaJobId` / `renderJobId` / publish state are persisted as soon as they exist), and re-enqueues a poll after 15–60 s (clamped by `minPollMs`/`maxPollMs`). Polls never consume attempts. After the per-step deadline → RECONCILIATION_REQUIRED with `EXTERNAL_WAIT_TIMEOUT`. Dispatcher (`orchestration.dispatcher.ts`): scene media is success only when `isCompletePackage()`; QUEUED/RUNNING is a wait; PARTIAL/incomplete or FAILED is a final failure. Render: SUCCEEDED → success; QUEUED/RUNNING → wait; FAILED_* / CANCELED → final failure. Publish: the first attempt calls M13 `publishNow`; after an upload exists it reads `getScheduledPost` and calls M13 `reconcile` while REMOTE_PROCESSING, and never calls `publishNow` again. GENERATE_SCRIPT also waits (up to 72 h) for the M07 human script approval, because M09 refuses unapproved scripts with 409 (found by the B6 test).
- **B4 atomic advance + recovery sweep.** Step completion, job SUCCEEDED, events, the run transition and the next step's QUEUED commit in one `$transaction` (`completeAndAdvance`, also used by approval resume); the enqueue happens after commit and `enqueueCurrent` never throws (it logs on the run, `nextAction: "Dispatch failed …"`). Completion/advance errors are outside the dispatch failure path, so they cannot mark a succeeded step or the run FAILED. `reconcileStalledWork(now)` runs on every worker tick: it re-enqueues QUEUED / RETRY_WAIT / WAITING_EXTERNAL steps that are due but older than `stallGraceMs` (2 min) — or immediately when the last dispatch failed — and promotes the next PENDING step (including the first step) of active runs with no active step, using the same deterministic job id. BullMQ `enqueue` removes a completed/failed job with that id and re-adds it; a pending one is DUPLICATE (in-memory adapter matches).
- **B5 failure classification.** `classify()`: explicit `WorkflowStepError` wins; `HttpException` with status < 500 and `ZodError` → final FAILED (`DOMAIN_REJECTED_<status>` / `DOMAIN_VALIDATION_FAILED`), never retried; any other error on a side-effect step → RECONCILIATION_REQUIRED (`UNKNOWN_SIDE_EFFECT_OUTCOME`); on a pure step → retry. The step idempotency key is passed to every service that accepts one (M09 scene media, M10 render). M07 `generate`, M11 `create`, and M14 `scheduleCollection` take no key, so those steps reuse the record an earlier attempt/poll persisted (`previousResultRef`) instead of creating a second one.
- **B6 real dispatcher end-to-end.** `orchestration.dispatcher.postgres.integration.test.ts`: a Nest `TestingModule` of the real `OrchestrationModule` + `WorkflowDomainDispatcher`, overriding only the DB, fixture LLM/image/video/TTS providers, local storage, the fake composition engine, the in-memory queue, and clocks. Flow: idea → script (waits for M07 approval, polled without regenerating) → approve → scene media (complete) → render queued (WAITING_EXTERNAL, one more poll still waiting) → M10 `runClaim` renders → poll sees SUCCEEDED → M11 review AI_REVIEW_UNAVAILABLE → WAITING_APPROVAL → a PUBLISH run for that render is refused by M13 preflight (`DOMAIN_REJECTED_409 "Publishing is blocked…"`, 1 attempt, no publish attempt row) → M11 human APPROVE → resume → SUCCEEDED.
- **Residuals fixed.** Claim checks `nextAttemptAt <= now` (1 s skew tolerance). The transition table is used by every service CAS (`transitionFrom` in `orchestration.state.ts`); it found and now allows QUEUED→RETRY_WAIT. Scheduled input is validated with the manual-run schema (invalid → slot SKIPPED `INVALID_SCHEDULE_INPUT`). Budget NOT_CONFIGURED/BLOCKED → slot SKIPPED, no PAUSED run. A concurrent duplicate manual idempotency key (P2002) returns the existing run. `skipSlot` is workspace-scoped. `ChannelService.listSchedulerCandidates()` is marked `@internal`. Concurrency/rate waits are counted in `limitWaits`, return the step to its prior state, and do not consume attempts.

## Commands and evidence (2026-11-10 after the review fixes, Node 24.22.2, pnpm 12.16.1, disposable `postgres:18.6-alpine` on 127.0.0.1:55437, `redis:7-alpine` on 127.0.0.1:56379)
- `pnpm install --frozen-lockfile`: **passed**.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`: **passed**.
- `DATABASE_URL=… REDIS_URL=redis://127.0.0.1:56379 pnpm test`: **passed**. 59 files passed / 1 skipped; 404 tests passed / 5 skipped. The only skips are the existing 5 FFmpeg/ffprobe tests.
- Focused M16 (`vitest run src/modules/orchestration`): 7 files / **60 tests passed**, 0 skipped: Postgres suite 22, real-dispatcher suite 1, **Redis/BullMQ suite 3 (ran against :56379, not skipped)**, unit/state/schedule/time 34. Plus `health.controller.test.ts` 1.
- `pnpm build`: **passed**. `pnpm db:validate`: **passed**.
- `pnpm db:migrate:deploy` on a dropped and recreated DB: **passed**, 24 migrations including `20261115010000_m16_orchestration_hardening`.
- `prisma migrate diff --from-config-datasource --to-schema`: no workflow_* drift; the remaining lines are the pre-existing pre-M16 FK naming drift.
- Worker fail-loud smoke: `node apps/worker/dist/main.js` with `REDIS_URL=redis://127.0.0.1:1` exits 1 with "REDIS_URL is set but the workflow queue is UNREACHABLE; refusing to start the orchestration worker".

## Phase-1 evidence (superseded by the section above)
- 56 files passed / 2 skipped; 390 tests passed / 7 skipped (Redis suite skipped then because no Redis client was installed).

## Acceptance evidence
- Restart/redelivery does not repeat side effects: redelivery, a new service instance, two racing workers, stale-lease recovery of a side-effect step (RECONCILIATION_REQUIRED, never re-run), a stale worker's late write after recovery (no-op, the step advances exactly once), and the BullMQ variant against real Redis.
- Manual and scheduled runs use the same definition and state machine (test).
- Paused channel: slot SKIPPED `CHANNEL_PAUSED`, manual start 409, an in-flight run pauses before its next step and resumes safely. Budget unavailable, approval pending, external waits, limit waits, and dispatch failures are visible through `state`, `pausedReason`, `budgetDecision`, and `nextAction`.
- Lost Redis jobs, enqueue throws, and a crash between completion and advance are recovered by the sweep (tests).
- A concurrent cancel and retry gives exactly one winner and one 409 (3 rounds).
- Limits: 12 concurrent lease attempts with limit 2 got exactly slots {0,1}; the rate counter allowed exactly 4 of 6; two workers with job-type concurrency 1 produce one dispatch and one LIMIT_WAIT that keeps `attempts = 0`.
- Timezone/DST tests as before.

## Contract/schema proposals
- Additive schema and migrations as approved: `20261114010000` (phase 1) and `20261115010000_m16_orchestration_hardening` (enum value + 3 columns, later than `20261114010000`). No `packages/contracts` change.

## Blockers / risks / unknowns (residuals left as notes per the review)
- Resume after M11 approval is manual: an editor calls `resume`, which re-reads the review. (Script approval, by contrast, is polled as an external wait.)
- The scheduler looks back 5 minutes and does not backfill longer outages; `workflow_scheduler_cursors` is written but not yet used to resume from.
- A schedule's own `timezone` overrides the channel timezone when valid.
- PROVIDER concurrency leases are per workspace, not global per provider.
- The worker boots the full `AppModule` (all modules) to get `OrchestrationService`.
- Retrying a step whose M10 render is FAILED_* re-reads the same render id; a new M10 retry child is not picked up automatically (operator retries the render in M10, then the step re-reads it only if the run input is updated). Follow-up.
- Steps waiting on script approval poll every 60 s for up to 72 h.
- Stuck M14 `RUNNING` collection jobs are not reclaimed (needs a new M14 method).

## Next exact action
Minu re-reviews PR #29 (fix-forward commits on top of `0c6b941`). Do not merge until approved.

## Handoff notes
No self-approval, integration, or merge is claimed.

## Reviewer decision
- Pending.
