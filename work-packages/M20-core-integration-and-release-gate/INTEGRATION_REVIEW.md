# M20 Integration Review (T01, T02, T06)

- **Base:** `origin/main` `97dd104413d1107f3d26b85b8dfa3c33d10e5e94` (M19 PR #34, M19 closeout PR #35, and redaction fix PR #36 are included).
- **Prepared by:** Minu backup implementation session, Desktop TRACXN-LP-784, worktree `reelforge-m20-minu`, branch `work/m20-core-integration-and-release-gate-minu`. This is integration evidence for review, not an approval.
- **Severity scale:** CRITICAL (release blocker now) / HIGH (blocks the affected production path or must be fixed before a real adapter is bound) / MEDIUM (fix before scale or before the next consumer lands) / LOW (hygiene or documentation).
- **Evidence method:** `gh pr view` / `gh api .../reviews` for every module PR (run 2026-11-10 20:42 IST); source reading at `97dd104`; the offline release-gate tests in `apps/api/src/modules/release-gate/`; the verification commands listed in `STATUS.md`.

## T01 - Approval matrix (every integrated module has an approval record)

All 20 modules M00–M19 have a written approval record on GitHub and an `INTEGRATED` `STATUS.md` whose approved commit matches the reviewed head. Six records are written approvals posted as **COMMENTED** reviews rather than the official `APPROVED` state; they are recorded with their caveat and not relabelled.

| Module | PR | Approval record (review id @ head) | Review state | Merge commit | Caveat |
|---|---|---|---|---|---|
| M00 | #2 | 5784762170 @ `626187a` | COMMENTED | `8fdcab5` | Written approval posted under `imTusharsingh` (owner account); official approve unavailable. |
| M01 | #4 | 5789945311 @ `519b3ab` | COMMENTED | `4944f5d` | Same as M00. |
| M02 | #6 | 5790491616 @ `a9bb14b` | COMMENTED | `216de53` | Same as M00. |
| M03 | #8 | 5790935899 @ `51fedc6` | COMMENTED | `408bae0` | Same as M00. |
| M04 | #10 | 5791871548 @ `110fbc0` (prior 5791575742 @ `a7a1069`) | COMMENTED | `c0a408d` | Same as M00. |
| M05 | #12 | 5797009894 @ `055e11f` | APPROVED | `618bd26` | none |
| M06 | #14, #15 | #14: none before merge; post-merge audit 5797242600 = NOT APPROVED. #15: 5798530110 @ `ed52885` | #14 COMMENTED, #15 APPROVED | `277525d`, `318d1f2` | PR #14 was merged without review (ADR-013 process breach). The fix-forward PR #15 carries the approval; the module is accepted on that record. |
| M07 + M08 | #16 | 5800027970 @ `e1f20d3` | APPROVED | `2d6d703` | Combined pack PR. |
| M09 | #17 | 5800496789 @ `99b1972` | COMMENTED | `589d28c` | "APPROVE-equivalent": the reviewer authored the PR, so GitHub blocked an official approve. |
| M10 | #18 | 5829841015 @ `2c6fcbb` | APPROVED | `7d00ced` | none |
| M11 | #20 | 5831183493 @ `e61af2b` | APPROVED | `42e33c5` | none |
| M12 | #22 | 5832180458 @ `16a3f0a`; 5832197458 @ `61e4d2f` (docs) | APPROVED | `a83132b` | none |
| M13 | #24 | 5833122821 @ `efa787a` | APPROVED | `75eee78` | none |
| M14 | #25 | 5833592187 @ `75b8603` | APPROVED | `02dbff5` | none |
| M15 | #27 | 5837873024 @ `9f5cdba` | APPROVED | `0e4e01a` | none |
| M16 | #29 | 5839211545 @ `1fbe818` | APPROVED | `602183a` | none |
| M17 | #32 | 5839978742 @ `9e8b9d6` | APPROVED | `f0feccd` | none |
| M18 | #31 | 5842769674 @ `6c49a4b` | APPROVED | `7e862fe` | none |
| M19 | #34 (+ #36) | 5843747594 @ `e5938e1`; #36: 5844093448 @ `2624830` | APPROVED | `3da846e`, `97dd104` | T07 open pending the retention ADR. |

**Acceptance 1 result:** PASS with caveats (6 COMMENTED written approvals; M06 PR #14 merged before review and corrected by approved PR #15). Core may choose to ratify these records explicitly in the closeout (Core decision 9 in `STATUS.md`).

## T02 - Contracts and schema

### Event contracts (`packages/contracts/src/events.ts`)

The registry has exactly two events, `PostPublished@1` and `PublishFailed@1`, both produced by M13 `publishing.service.ts` inside the publish transaction (outbox upsert keyed by `(workspace_id, idempotency_key)`, payload parsed by the registry schema before insert). The offline round-trip test proves both payloads validate at the producer, still validate after persistence, and are mapped by M17 intake to `PUBLISH_SUCCEEDED` / `PUBLISH_FAILED` for the right tenant and channel.

| # | Finding | Severity | Owner | Evidence |
|---|---|---|---|---|
| E1 | Registry declares consumers that do not exist: `PostPublished@1` lists M14 and `PublishFailed@1` lists M16, but only M17 reads `outbox_events` (`notifications.sources.ts`, `reports.service.ts`). M14 collects from M13 published records via `PublishingPublishedPostSource`; M16 never reads the outbox. | MEDIUM | M00 contracts / Core | `grep` over `apps/**` at `97dd104`; Gate 3 "contract versions match producer and consumer" |
| E2 | No outbox relay: `outbox_events.published_at` is never set and no consumer acknowledges delivery. The registry's retry policy and `reelforge.events.dead-letter` queue are declared but not implemented anywhere. M17 instead keeps its own keyset cursor (ADR-018). | MEDIUM | M00 / M13 / Core | no writer of `publishedAt` in `apps/**`; no queue named `reelforge.events.dead-letter` |
| E3 | M17 does not validate outbox payloads with `parseRegisteredEvent`; it picks known keys from the JSON. The producer validates, so current data is valid, but Gate 3 asks for validation at both ends. | LOW | M17 | `notifications.sources.ts` `pick(...)` |
| E4 | M13 events use a fresh random `correlationId` instead of the workflow run's correlation id, so an event cannot be joined to the M16 run / M08 ledger / audit trail by correlation. | MEDIUM | M13 | `publishing.service.ts` `correlationId: randomUUID()` |
| E5 | `PublishFailed` is emitted only for `YOUTUBE_PROCESSING_FAILED` during reconcile. Other final failures (for example upload `FAILED_FINAL`, session-persist exhaustion) produce no event, so M17 failure notifications and report failure counts under-count. | MEDIUM | M13 | `publishing.service.ts` only `PublishFailedV1Schema.parse` site |
| E6 | M17 reads M13's table directly (M17 residual R4), against ADR-001 "communicate through approved services/events". Accepted at M17 review; tracked. | LOW | M17 / M13 | M17 residual R4 |

### Schema and migrations

- `prisma validate`: passes. Fresh `migrate deploy`: 27 migrations, ordered and applied once (also enforced by `release-gate.migrations.test.ts`). M20 adds **no migration** and no `schema.prisma` change.
- `prisma migrate diff` (fresh DB -> `schema.prisma`): **84 lines of pre-existing drift**, identical before and after this branch (`.local-data/m20-drift-baseline.sql` vs `m20-drift-after.sql`). Inventory:

| # | Drift item | Owning module | Severity | Note |
|---|---|---|---|---|
| S1 | `channels_active_snapshot_fkey` in DB is `(workspace_id, active_snapshot_id)` `ON DELETE SET NULL`; schema expects `channels_workspace_id_active_snapshot_id_fkey` `ON DELETE RESTRICT`. Postgres `SET NULL` without a column list would also null `workspace_id` (NOT NULL), so deleting an active snapshot errors instead of clearing the pointer. | M02 | MEDIUM | Behaviour differs from schema; snapshots are immutable and not deleted by app code today. |
| S2 | DB has `scripts_created_by_user_id_fkey` and `script_revisions_created_by_user_id_fkey` (to `users`, RESTRICT) that `schema.prisma` does not model. DB is stricter than schema. | M07 | LOW | Prisma would drop them on a future `migrate dev`. |
| S3 | `genre_templates.id`, `genres.id` have a DB default; `ideas.updated_at` has a DB default. Schema has none. | M03 / M06 | LOW | Harmless; Prisma would drop the defaults. |
| S4 | 15 foreign keys named differently in DB vs Prisma's convention (M02 snapshots, M09 scene media, M10 render tables, M15 strategy changes). | M02 / M09 / M10 / M15 | LOW | Names only. |
| S5 | 5 index names truncated at 63 chars differently (M15 performance tables). | M15 | LOW | Names only. |
| S6 | M18 partial unique index `usage_reservations(workspace_id, correlation_id)` exists only in migration SQL (Prisma cannot model partial indexes). It does **not** appear in the diff, so it is safe today; a future `migrate dev` reset must keep it. | M18 | LOW | M18 residual. |

No corrective migration is written in M20: Core decision 6. If approved, it is one migration `20261119010000_m20_schema_drift_reconcile`.

### Shared files

M20 changed no shared file: no root config, no `packages/contracts/**`, no `schema.prisma`, no migration, no `app.module.ts`, no `ci.yml`, no lockfile, no dependency.

## T06 - Security, tenant isolation, cost, idempotency, failure recovery

### Offline evidence added by M20

- **Tenant isolation:** every one of the **159** `:workspaceId` routes in the booted `AppModule` was checked as another workspace's OWNER; the broad sweep returned no 2xx or 5xx (GET only 403/404). Separate valid-payload channel create and update requests returned 403 and left the victim row/count unchanged. The checks wrote nothing into the victim tenant (no channel, run, provider request, or successful audit row by the attacker).
- **Authentication:** all 159 workspace routes return 401 without a session. The only unscoped routes are the reviewed list `GET /health`, `GET /ops/metrics` (404 when `OPS_METRICS_TOKEN` is unset), `GET /social-accounts/oauth/:platform/callback`, `GET|POST /workspaces` (401 without a session), `POST /auth/login|logout|register`. A new unscoped route now fails the release-gate test until reviewed.
- **No live calls:** `fetch` is a throwing spy in all release-gate tests and is never called.
- **No fake success:** with the default runtime bindings every AI boundary (M06 idea LLM, M07 script LLM, M09 image/video/TTS, M11 quality review, M15 insight LLM), the M17 email sender, the M18 billing provider and the M12 Instagram connector are NOT_CONFIGURED and reject; the provider registry is empty, and every AI capability has a `null` cost model so the M08/M18 preflight cannot dispatch.

### Findings

| # | Finding | Severity | Owner |
|---|---|---|---|
| C1 | Paid-call budget coverage is partial. Only M07 script and M09 scene-media reserve through M18 / write the M08 ledger. M06 idea proposal (`IDEA_PROPOSAL_LLM`), M11 AI quality review (`QUALITY_REVIEW_PORT`) and M15 insight LLM call their port with **no M08 ledger row and no M18 reservation**. Not exploitable now (adapters are NOT_CONFIGURED), but binding any real adapter there would spend without a budget gate (ADR-018 item 2). | HIGH (gate on binding a real adapter) | M06, M11, M15 |
| C2 | Unconfigured M06 idea proposal returns **HTTP 500** (plain `Error`), not a clear NOT_CONFIGURED 4xx/503. Same pattern in the M07 `NotConfiguredScriptLlm` (plain `Error`; normally unreachable because the empty registry refuses first). No data or charge is created (release-gate test). | LOW | M06, M07 |
| C3 | Release prerequisites that are owner decisions, not defects: production KMS / key delivery and rotation (M12, M13), hosting region, AI vendor/model, email sender, retention/deletion/export (M19-T07 / R14). | BLOCKER for production (owner gate) | Owner / Core |

### Carried residuals (recorded, not fixed in M20)

- **M19:** R3 Prisma validation errors can print argument values. R4 non-URL local file paths are not masked. R6 a stop mid-step fails the run instead of pausing it. R7 the manual-run 409 during a stop says "Budget policy blocked". R8 the audit write is not transactional with the action and redirects are recorded as 200. R9 audit paging (`before=`) skips rows with equal timestamps. R10 a simultaneous first-time stop on one scope returns 500. R11 metrics are in-memory, per process. R12 audit rows are undeletable (intentional). R13 the GLOBAL stop env must be set on both API and worker. R14 / T07 retention, deletion and export are OPEN pending the retention ADR (including audit retention). R1, R2, R5 were fixed by PR #36.
- **PR #36 review:** N1 substring key matching over-redacts (for example `max_tokens`). N2 escaped-JSON values lose their quote shape when masked. N3 the fatal log line can be lost because exit runs right after the write. N4 ESM import-time throws in the worker happen before the handlers are installed.
- **M10–M18:** carried by module exactly as listed in `docs/PROJECT_STATE.md` "residual notes". The ones that touch the release gate directly:
  - Idempotency / duplicate side effects: M13 crash between `startVideoUpload` and session persist can leave `UPLOADING` with no session URI (refuses a second insert, so no duplicate publish, but needs manual action). M16 crash-retry of script/QA/analytics steps can create a new record; BullMQ re-add is not atomic; a per-claim token is required before worker concurrency > 1. M15 concurrent recommendation generation can duplicate rows.
  - Failure recovery: M14 `RUNNING` jobs are not reclaimed; M18 failed finish-hold expires after 60 min and the expiry sweep is not on a worker tick; M10 pending-upload rows need manual resolution; M17 poison event can block the fan-out head (R5).
  - Cost: M18 each check rescans the ledger; ledger lacks RENDER/PUBLISH/ANALYTICS sources; M16 fails over-budget runs instead of pausing.
  - Security: M12 reconnect overwrites the old refresh grant without revocation; M18 append-only trigger allows deletes too broadly.

### Release-blocking assessment (acceptance 4)

No **CRITICAL** security, publishing, or data-loss defect was found in code at `97dd104`. The release is still **BLOCKED** because the Gate 5 items that depend on owner decisions (retention/deletion, KMS, provider vendors, email sender) and Gate 4 live verification are not done. See `RELEASE_CHECKLIST.md`.
