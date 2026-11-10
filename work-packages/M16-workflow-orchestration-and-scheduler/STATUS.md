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
~90% (estimate only, not an approval). The BullMQ/Redis transport is written but cannot connect until a Redis client peer is approved (see Blockers).

## Task checklist
- [x] M16-T01: Run/step/job state machines (`orchestration.state.ts`); every transition is an `updateMany` compare-and-swap on the expected status, and a failed CAS is a 409 or a no-op.
- [x] M16-T02: `WorkflowQueuePort` with a BullMQ 6.6.0 adapter, an in-memory adapter, and a NOT_CONFIGURED adapter. Job ids are deterministic (`run.step.retryGeneration.attempt`). Attempts, exponential backoff, and dead letter (`workflow_jobs.status = DEAD_LETTER`, `dead_lettered_at`) are persisted in Postgres.
- [x] M16-T03: Channel schedule evaluation in the channel's IANA timezone (DST gap skipped, fall-back ambiguity yields one slot). Slots are claimed through a unique `(workspace, channel, slotKey)`. Paused or archived channels get a SKIPPED slot. The budget port defaults to NOT_CONFIGURED, so scheduled runs are PAUSED with `BUDGET_POLICY_UNAVAILABLE`. Approval waits are visible.
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

## Commands and evidence (2026-11-10, Node 24.22.2, pnpm 12.16.1, disposable `postgres:18.6-alpine` on 127.0.0.1:55437, `redis:7-alpine` on 127.0.0.1:56379)
- `pnpm install --frozen-lockfile`: **passed** (lockfile up to date).
- `pnpm lint`: **passed**.
- `pnpm format:check`: **passed**.
- `DATABASE_URL=… pnpm typecheck`: **passed** (all 11 workspaces).
- `DATABASE_URL=… pnpm test`: **passed**. 56 files passed / 2 skipped; 390 tests passed / 7 skipped. The skips are the existing 5 FFmpeg/ffprobe tests plus the 2 Redis/BullMQ tests (see Blockers). Re-run on a freshly migrated DB gave the same result.
- Focused M16: 5 files passed / 1 skipped; 47 tests passed / 2 skipped. The PostgreSQL integration suite (14 tests) passed in three consecutive runs.
- `DATABASE_URL=… pnpm build`: **passed** (exit 0).
- `DATABASE_URL=… pnpm db:validate`: **passed**.
- `DATABASE_URL=… pnpm db:migrate:deploy` on a dropped and recreated DB: **passed**, 23 migrations applied from scratch.
- `prisma migrate diff --from-config-datasource --to-schema`: **no workflow_* drift**. Index names were aligned to Prisma's 63-char truncation, and the missing `workflow_runs (workspace_id, channel_id, created_at)` index was added. The remaining diff lines are pre-existing pre-M16 naming drift.
- `REDIS_URL=redis://127.0.0.1:56379 vitest run …orchestration`: the Redis suite **NOT RUN (skipped)**. BullMQ 6.6.0 cannot load a Redis client (see Blockers). With `REDIS_URL` set, the queue factory degrades to NOT_CONFIGURED, and a unit test asserts that.
- Worker smoke: `node apps/worker/dist/main.js` with DATABASE_URL, run once with `REDIS_URL` unset and once with it set. Both stayed up for 8 s and exited 0 on SIGTERM. With `REDIS_URL` set it logged the missing Redis-client warning and did not crash.

## Acceptance evidence
- Restart/redelivery does not repeat side effects. In-memory and Postgres tests cover redelivery to the same worker, a new service instance ("restart"), two workers racing on one job (one claims it, the other no-ops), and stale-lease recovery of a side-effect step. That step goes to RECONCILIATION_REQUIRED and is never re-run, and a late domain result is recorded on the step. BullMQ variant: written, not run (Blockers).
- Manual and scheduled runs use the same definition and state machine (test).
- Paused channel: the slot is SKIPPED with `CHANNEL_PAUSED` and no run starts. Manual start on a paused channel returns 409. An in-flight run pauses before its next step and resumes safely. Budget unavailable and approval pending are visible through `state`, `pausedReason`, `budgetDecision`, and `nextAction` (tests).
- Each run exposes state, current step, failures (`lastError*` plus per-step and per-job errors), attempts, retryGeneration, dead letter, and nextAction (tests).
- A concurrent cancel and retry, held at a barrier after both read FAILED, gives exactly one winner and one 409 (3 rounds).
- Limits: 12 concurrent lease attempts from two Prisma clients with limit 2 got exactly slots {0,1}. The rate counter allowed exactly 4 of 6. Two orchestration workers with job-type concurrency 1 produced one dispatch and one LIMIT_WAIT.
- Timezone/DST: New York spring-forward gap and fall-back, London fall-back, Asia/Kolkata and New York local weekday/date different from UTC, and stable slot keys across overlapping windows.

## Contract/schema proposals
- Additive schema and migration as approved (timestamp `20261114010000` > `20261113010000`). No `packages/contracts` change. The view types are module-local.

## Blockers / risks / unknowns
- **BLOCKER (needs Core approval): BullMQ 6.6.0 needs a Redis client peer.** `ioredis` and `redis` are optional peer dependencies, and neither is in the lockfile. `new Queue(...)` throws "BullMQ could not load the optional 'ioredis' package". The approval allows no other dependencies, so I did not add one. Mitigation in this PR: `redisClientAvailable()` detects the peer, and with `REDIS_URL` set but no client, dispatch stays NOT_CONFIGURED and nothing crashes, in both API and worker. To unblock: approve pinning `ioredis` (exact version) in `apps/api` and `apps/worker`, then run `orchestration.bullmq.redis.integration.test.ts` against :56379.
- Dispatch requires a queue. With NOT_CONFIGURED, manual runs persist as QUEUED with `nextAction: "Configure REDIS_URL…"`. The worker tick's `dispatchUndispatchedRuns()` dispatches them once a queue is configured.
- A LIMIT_WAIT consumes a step attempt, because the job id is per attempt. Heavy limit contention can therefore leave fewer retries for real failures. Follow-up: a separate limit-wait counter.
- Approval is not polled. After M11 approval, an editor must call `resume`, which re-reads the review. Auto-advance on approval is deferred.
- The scheduler only looks back 5 minutes. Slots missed during a longer worker outage are not backfilled.
- If Redis loses queued jobs (for example on a Redis restart without persistence), steps stay QUEUED with no reconciler. Stale recovery only covers RUNNING leases.
- Stuck M14 `RUNNING` collection jobs are **not** reclaimed. Doing that would need a new M14 method, so it is left as allowed.
- Dispatcher domain wiring (`orchestration.dispatcher.ts`) is unit-shaped only. Tests use fixture dispatchers, with no live AI, Google, or Meta calls, so the real M06–M14 call payloads have no end-to-end test yet.
- Scheduled runs act as the workspace's first OWNER, re-checked on each step. Manual runs act as their starter, and the starter's current role is re-checked on each step.

## Next exact action
Minu reviews the PR. Core decides on the Redis client peer (`ioredis` pin); once approved, add it and run the Redis suite with `REDIS_URL=redis://127.0.0.1:56379`.

## Handoff notes
No self-approval, integration, or merge is claimed.

## Reviewer decision
- Pending.
