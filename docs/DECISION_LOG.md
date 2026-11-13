# Architecture Decision Log

This log is append-only. An approved decision may be superseded by a later approved entry; never rewrite history silently.

## ADR-001 - Modular monolith with independent worker process

- **Status:** APPROVED BASELINE
- **Decision:** NestJS modular monolith, separate API and worker processes, domain modules, no microservices in v1.
- **Reason:** Keeps module ownership clear while avoiding early distributed-systems complexity.
- **Consequence:** Modules must communicate through approved services/events and cannot share arbitrary internal code.

## ADR-002 - TypeScript monorepo and selected stack

- **Status:** APPROVED BASELINE
- **Decision:** pnpm workspaces, Next.js frontend, NestJS backend, PostgreSQL, Prisma, Redis/BullMQ, S3-compatible storage, FFmpeg.
- **Consequence:** Root tooling and central database schema are Core-owned. Versions are pinned.

## ADR-003 - Multi-tenant workspace boundary

- **Status:** APPROVED BASELINE
- **Decision:** Workspace is the tenant boundary. Multiple channels per workspace. User roles in v1: owner, editor, viewer. Team invitations are deferred.
- **Consequence:** Every user-owned record and query is workspace-scoped and tested against cross-tenant access.

## ADR-004 - YouTube before Instagram

- **Status:** APPROVED BASELINE
- **Decision:** YouTube is the first publishing and analytics connector. Instagram is the next connector after the YouTube vertical slice is stable. TikTok and Facebook Reels are out of v1.
- **Consequence:** Social modules must expose a platform-neutral adapter contract; no platform-specific assumptions in core publishing logic.

## ADR-005 - Human approval is default

- **Status:** APPROVED BASELINE
- **Decision:** Manual review is default. Per-channel auto-publish may be enabled only when hard gates pass and the configured score threshold is met.
- **Consequence:** A quality score cannot override rights, safety, technical, permission, or policy hard gates.

## ADR-006 - Deterministic orchestration

- **Status:** APPROVED BASELINE
- **Decision:** BullMQ and explicit state machines in v1. LLMs generate structured content but do not choose arbitrary tools or state transitions.
- **Consequence:** Every job is typed, idempotent, observable, retry-bounded, and persisted.

## ADR-007 - AI provider abstraction and no fake runtime integrations

- **Status:** APPROVED BASELINE
- **Decision:** All model/media capabilities sit behind provider-neutral interfaces. Runtime adapters must perform real configured provider work or fail clearly. No fake success path.
- **Consequence:** Offline tests may use fixtures/stubs at test seams, but that is not integration proof. Live calls require explicit authorization and budget.

## ADR-008 - Layered versioned configuration

- **Status:** APPROVED BASELINE
- **Decision:** platform -> workspace -> channel -> genre -> series -> character -> video override. Lock system/safety/rights settings. Store immutable snapshots per generation.
- **Consequence:** Prompt changes do not rewrite historical generation context.

## ADR-009 - Recommendations do not auto-mutate channel settings in v1

- **Status:** APPROVED BASELINE
- **Decision:** Learning engine produces evidence-linked recommendations. User approval is required before changing strategy/configuration.
- **Consequence:** Learning is controlled and auditable; no reinforcement loop that silently changes behavior.

## ADR-010 - No live provider calls in normal development or CI

- **Status:** APPROVED BASELINE
- **Decision:** App startup, migrations, seeds, health checks, unit/contract tests, and CI do not call paid/side-effecting external APIs. Live verification is a separately authorized operator action.
- **Consequence:** Test fixtures prove local logic, not external integration. Production readiness requires explicit live evidence when authorized.

## ADR-011 - v1 non-goals

- **Status:** APPROVED BASELINE
- **Decision:** No competitor scraping, visual workflow builder, full video timeline editor, comments/DM automation, subscription billing, custom model training, TikTok, or Facebook Reels in v1.
- **Consequence:** Proposals for these features go to a later release unless the owner explicitly re-scopes v1.

## ADR-012 - Approved dependency and CI version pins

- **Status:** APPROVED (Core Reviewer Minu; recorded as part of M00 integration).
- **Decision:** Keep the following exact dependency and CI pins from the approved M00 status:

| Component | Version |
|---|---|
| Node.js (LTS) | 24.22.2 |
| pnpm | 12.16.1 |
| Next.js | 16.4.5 |
| React / React DOM | 19.3.1 |
| NestJS common/core/platform-express | 12.3.3 |
| Express / @types/express | 5.3.0 / 5.0.6 |
| BullMQ | 6.6.0 |
| Prisma CLI / Client / PostgreSQL adapter | 7.10.1 |
| node-postgres (pg) | 8.23.1 |
| Zod | 4.6.7 |
| TypeScript | 6.0.3 |
| Vitest | 5.1.0 |
| ESLint / typescript-eslint | 10.14.0 / 8.72.1 |
| Prettier | 3.9.10 |
| @types/node / @types/react / @types/react-dom | 24.19.2 / 19.3.0 / 19.3.0 |
| reflect-metadata / RxJS | 0.2.2 / 7.8.2 |
| PostgreSQL CI service | 18.6 |

CI pins verified on integrated `main` in `.github/workflows/ci.yml`: runner `ubuntu-24.04`; `actions/checkout@v7`; `pnpm/action-setup@v6` with `version: 12.16.1`; and `actions/setup-node@v7` with `node-version-file: .node-version` and `cache: pnpm`.
- **Consequence:** Later modules must not bump these versions without a Core-approved ADR and lockfile change.

## ADR-013 - Owner-only merge and process-based main protection

- **Status:** APPROVED (owner direction, 2026-11-05).
- **Decision:** Keep the repository private. GitHub branch-protection enforcement is unavailable or unused on the current free plan, so protection is process-based:
  1. Only the repository owner merges to `main`.
  2. Every PR requires Minu's written approval on the PR before merge.
  3. Coding bots and implementer sessions never push to `main` and never merge PRs.
- **Consequence:** Task prompts and reviews must restate these rules; Minu refuses to approve work that violates them. If the repository becomes public or moves to a plan or organization that supports enforced protection, Minu will add real branch rules.

## ADR-014 - First-party email/password credentials and hashed server sessions

- **Status:** APPROVED (Core Reviewer Minu; recorded as part of M01 integration).
- **Decision:** v1 authentication is first-party email and password. Passwords are stored as scrypt hashes. Login and registration set an HTTP-only `reelforge_session` cookie. The server stores only a hash of the session token; sessions expire and are revocable on logout. Authentication outcomes are persisted as auth events. Commercial identity providers (Clerk, Auth0, and Cognito) are not adopted for v1.
- **Reason:** This is the identity design delivered in M01 and accepted by Minu's written approval of PR #4 at `519b3ab2bd6a81a516c66d21036051edb9c54894`. No earlier ADR recorded the choice.
- **Consequence:** Later modules use the M01 principal, hashed session, and workspace membership boundary. Adopting a commercial identity provider requires a later ADR.

## ADR-015 - Channel configuration snapshots and destination intents

- **Status:** APPROVED (Core Reviewer Minu; recorded as part of M02 integration).
- **Decision:** Channel configuration is persisted in immutable `ChannelConfigSnapshot` versions selected by the channel's `activeSnapshotId` pointer. Publishing destinations in M02 are stored as configuration references/intents only; OAuth credentials and live platform linking remain owned by M12.
- **Consequence:** Downstream modules can select and inspect durable channel configuration without coupling M02 to social-provider credentials or live platform APIs.

## ADR-016 - Immutable character/asset versions and the M04 storage boundary

- **Status:** APPROVED (Core Reviewer Minu; recorded as part of M04 integration at `110fbc0f0f4925f062815dbca68b6b9d666abd33`, merged via PR #10 at `c0a408d9572011c3b0d66e6b6704d722477dc275`).
- **Decision:** M04 delivers these durable boundaries:
  1. Publishing a character creates an immutable `CharacterVersion`; reference packages resolve exact pinned character versions and exact asset versions with SHA-256 checksums. Published versions and reference packages are not rewritten in place.
  2. Assets are append-only version chains with checksum, license/rights metadata, and usage references; a new version supersedes rather than mutates prior bytes.
  3. Binary media goes through a storage port. M04 ships only the local filesystem adapter, and unimplemented drivers such as `s3` fail loudly. A production S3-compatible adapter remains owned by M10/`packages/media`.
  4. Starter characters (`starter-nova`, `starter-atlas`) use project-authored CC0-1.0 placeholder PNG bytes embedded in code, with rights metadata seeded by migration; there are no downloads or provider-generated starter assets.
  5. M03 `characterGroupRefs` remain opaque IDs; M04 does not automatically rewrite or sync them when M04 assignments change.
- **Reason:** These choices are what M04 implemented and what Minu approved on PR #10. No earlier ADR recorded them.
- **Consequence:** Generation jobs consume immutable references rather than mutable asset records. Changing versioning/rights semantics or adding production object storage requires a later ADR. The open Prisma Client / Nest ESM boot follow-up is an engineering gap, not a decision resolved by this ADR.

## ADR-017 - M16 orchestration Core decisions and M17/M18 parallel plan

- **Status:** APPROVED (Core Reviewer Minu; recorded as part of the M16 integration closeout after PR #29 was approved at `1fbe818174ebdfd87218ca5d68e3ad5f6ff17e5c`, review `5839211545`, and squash-merged at `602183aeed1f2fe9fa086cf819f86fc7de07bb72`).
- **Decision:**
  1. `ioredis` 5.11.1 is pinned in `apps/api` and `apps/worker` as the Redis client for BullMQ 6.6.0 (ADR-012). A set but unreachable `REDIS_URL` fails loudly; an unset `REDIS_URL` stays NOT_CONFIGURED.
  2. A generated run's script step waits (polled, up to 72 h) for human M07 script approval before scene media, because M09 refuses unapproved scripts. This follows ADR-005 (human approval by default).
  3. M17 and M18 are implemented in parallel worktrees with fixed migration timestamps: M17 `20261116010000`, M18 `20261117010000`. M17 merges first; M18 then rebases onto it.
  4. M18 provides the real `BudgetPolicyPort` adapter. Until it is bound, scheduled runs stay blocked with `BUDGET_POLICY_UNAVAILABLE`; manual runs are allowed.
- **Consequence:** Changing the Redis client, removing the script approval wait, or changing the M17/M18 migration order requires a later ADR.

## ADR-018 - M17 intake cursor and M18 paid-call budget reservation

- **Status:** APPROVED (Core Reviewer Minu; recorded as part of the M17+M18 integration closeout. M17 PR #32 was approved at `9e8b9d6fb02bef5fa280f7ae001f21f3e19f7a29`, review `5839978742`, and squash-merged at `f0feccd0be9d4052e8484b5ea8214aa239f95a8b`. M18 PR #31 was approved at `6c49a4b878126e3d1a3639d1db4ab0db8944c79c`, review `5842769674`, and squash-merged at `7e862fec80e5f7524ecc6cfdc0ef62165a410e5e`.)
- **Decision:** These record review decisions already approved on PR #32 and PR #31; no new policy.
  1. M17 notification intake uses a strict `(ts, id)` keyset with no stall branch. A fresh cursor starts at `now - settle` and does not replay history unless `intakeBackfill` is set. The settle window assumes source transactions commit within ~5 s and clock skew stays under ~30 s (M17 residual R1).
  2. M18 paid script and scene-media calls reserve through M18 **before** the provider is called. A failed call that was already dispatched is charged at its estimate. Only a provably not-dispatched call is released. If the budget policy throws, the M16 scheduler marks the slot `SKIPPED` / `BUDGET_POLICY_ERROR`.
  3. ADR-017 item 4 is done: the real `BudgetPolicyPort` adapter (M18 `UsageBudgetPolicy`) is bound. Unconfigured budgets still block scheduled runs and allow manual ones.
- **Consequence:** Replaying intake history by default, calling a paid provider before an M18 reservation, or treating a dispatched failure as free requires a later ADR.

## ADR-019 - M19 admin, emergency stop, audit and observability Core rulings

- **Status:** APPROVED (Core Reviewer Minu; recorded as part of the M19 integration closeout. M19 PR #34 was approved at `e5938e1484972afaf4125f6396646b9fb4483b20`, review `5843747594`, and squash-merged at `3da846e10bc8b682639a32c46bcefc9f529f6e0b`.)
- **Decision:** These record the M19 "Core decisions requested" that Minu approved on PR #34; no new policy.
  1. "Admin" is the workspace **OWNER** (ADR-003). No new role and no platform-operator role. The only platform-wide control is the GLOBAL emergency stop, which is set by operator environment (`REELFORGE_EMERGENCY_STOP`) only and cannot be set over HTTP.
  2. The emergency stop goes through the M19 decorator in front of the M18 `BudgetPolicyPort` adapter, plus one step-boundary pause in M16 `processJob` that reuses `PAUSED` / `pausedReason` (no new M16 state). Analytics metric reads and social OAuth connect are not blocked; `WAITING_EXTERNAL` polls, M13 reconcile and sweeps keep running.
  3. Audit history is the append-only `audit_events` table (no FKs; triggers reject UPDATE/DELETE/TRUNCATE), fed by one global HTTP interceptor. Guard-level 401s are covered by M01 `auth_events`, not by `audit_events`.
  4. No new observability dependency (OTel SDK deferred to a future pin). `/ops/metrics` is token-gated (`OPS_METRICS_TOKEN`) and returns 404 when unset.
  5. A single `/health` route with `probe=liveness|readiness`; readiness gates on Postgres only.
  6. Admin views are API-only and OWNER-only, workspace-scoped.
  7. The CI dependency-audit step (`pnpm audit --prod --audit-level high`) is approved in principle, to land as a separate `ci.yml` chore PR.
- **Consequence:** Adding an admin/operator role, setting the GLOBAL stop over HTTP, making audit rows mutable or deletable, adding an observability dependency, or adding readiness dependencies beyond Postgres requires a later ADR. M19-T07 retention/deletion/export, including audit retention, stays open until the retention ADR is decided.

## ADR-020 — Issue #69 process cleanup and controlled integration

- **Status:** Owner process decisions recorded by the explicit #80 closeout assignment (2026-11-13); this documentation PR still requires independent Minu review. This entry does not approve its own PR or authorize a merge.
- **Basis:** Issue #69 process proposal [6822481475](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6822481475), Minu's independent gate decision [6831915757](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6831915757), scoped release [6832504863](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832504863), implemented gates [#72](https://github.com/imTusharsingh/reelforge/pull/72), and the owner's #80 assignment.
- **Decisions:**
  1. Independent Minu review of the exact current head is required before merge. Implementers do not self-review, approve or merge. Green CI does not substitute for acceptance evidence or review.
  2. The separately authorized integrator uses squash-only merges after checking current head/base, review, required CI and unresolved blockers. Existing historical non-squash merges are not rewritten. Update branches by merging main; never force-push.
  3. ci.yml and PROJECT_STATE changes belong in dedicated chore PRs. Keep one task/pack per PR and do not bundle those files into feature implementation.
  4. Secret scanning is mandatory and participates in Required CI; failure, skip or cancellation cannot be treated as success. Process Policy remains a separate required procedural integration check. Dependency audit findings are report-only, while unavailable/error outcomes remain visible and require disposition.
  5. Keep exact dependency pins, read-only CI credentials, no live provider calls in tests/startup/CI, and no committed .env/.local-*/.vscode. The staged pre-commit hook from #98 supplements CI; run pnpm install after merging main.
- **Enforcement limits:** The repository is now public. This session verified that GitHub metadata still permits merge commits and rebase merges as well as squash; it did not change settings or establish branch-protection enforcement. Squash-only and independent review therefore remain mandatory process requirements even where repository settings permit bypass. #72 documents the trusted-base policy check and residual integration obligations.
- **Consequence:** ci.yml/PROJECT_STATE work and E2E CI wiring require a separate reviewed chore PR; live-provider/release approvals, #78's paid-operation work and #79's browser evidence remain distinct gates.

## Pending decisions before affected implementation

These are implementation-specific choices, not permission to invent behavior:

1. **Actual AI provider vendors/models:** select only after capability, commercial terms, region/data handling, output rights, quality, rate limits, and cost are compared. M08/M09 must not claim a provider is supported before this review.
2. **Email sender:** choose only if email notifications are enabled; in-app notifications can ship independently.
3. **Hosting/cloud region and production KMS:** confirm before production deployment.
4. **Data retention durations:** owner must approve retention/deletion policy before production media/analytics data accumulates.

Each pending decision must be resolved in an ADR before the affected production block is approved.

## ADR-021 — M08 paid-operation boundary and M18 accounting

- **Status:** ARCHITECTURE ACCEPTED, revision 2; implementation NOT authorized by this record.
- **Exact accepted contract:** [preserved CC-69-A-01 / ADR-021 revision 2](proposals/issue-69-a/frozen/CC-69-A-01_ADR-021.md), [posted text #6832104336](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832104336).
- **Independent acceptance:** [minu-the-reviewer #6832215027](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832215027). The revision-2 amendment controls conflicting earlier proposal wording. Original PENDING headers are preserved submission history.
- **Decision:** M08 owns the paid-operation boundary; M18 owns transaction-aware reservation/authorization/settlement. Persist exact READY non-dispatch classification and atomic T2 dispatch claim. Unclaimed READY expiry produces zero false spend, while dispatched uncertainty remains conservatively covered; same-key uncertain replay never redispatches. Preserve M07 manual policy. A-POL-01 requires new M06/M11/M15 paths to fail closed without M18 authorization.
- **Conditions:** Actual crash/expiry/lock/commit-ambiguity tests T21-13..19 and all remaining acceptance evidence are mandatory. Exact source, schema and SQL require their downstream gates; no implementation result is claimed.

## ADR-022 — Conservative M17 publishing intake and bounded recovery

- **Status:** ARCHITECTURE ACCEPTED; implementation NOT authorized by this record.
- **Exact accepted contract:** [preserved CC-69-A-02 / ADR-022](proposals/issue-69-a/frozen/CC-69-A-02_ADR-022.md), [posted text #6831936692](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6831936692).
- **Independent acceptance:** [minu-the-reviewer #6832033899](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832033899).
- **Decision:** Owner A-POL-02 accepts scoped conservative intake limitations; retain no eventual-delivery, published_at acknowledgement or active broker-DLQ guarantee. Use validated M13-owned reads, poison-page blocking, bounded OWNER diagnostics/fingerprint replay with transactional audit, durable origin/marked legacy correlation, and prospective attempt-specific final failures. Preserve v1 wire contracts and ordinary cursor behavior.
- **Conditions:** Demonstrate tenant/role/range/fingerprint denial, replay/audit atomicity, duplicate resistance, late-commit and malformed-event handling, owning-service boundaries and zero publication invocation during replay. Diagnostics describe only scanned committed rows and current receipt state, not universal delivery.

## ADR-023 — Non-destructive schema reconciliation and A persistence

- **Status:** SCHEMA ARCHITECTURE/INVENTORY ACCEPTED, revision 2; exact executable SQL NOT APPROVED.
- **Exact accepted contract:** [preserved CC-69-A-03 / ADR-023 revision 2](proposals/issue-69-a/frozen/CC-69-A-03_ADR-023.md), [posted text #6832104919](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832104919).
- **Independent acceptance:** [minu-the-reviewer #6832215027](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832215027), following directional acceptance in #6832033899.
- **Decision:** S1 RESTRICT; preserve S2 creator FKs, S3 defaults, sixteen S4 physical FK names and five S5 index names/uniqueness. Add only accepted operation state/link/check inventory and nullable publishing correlation fields. Cross-table accounting invariants belong to M08/M18 transactions, not ordinary row CHECKs.
- **Conditions:** Separate independent exact-SQL and lock/validation review before execution; fresh/populated-upgrade proof, previous migration checksums, tenant/workspace cascade behavior, SQL-only trigger/CHECK/partial-index preservation and empty executable diff. The inherited 84-line diff and [SQL proposal](proposals/issue-69-a/SQL_REVIEW_PROPOSAL.txt) are NOT authorized migrations. Recheck future timestamp before creation.

- **Exact SQL adverse review:** SQL v1 is **REQUEST CHANGES / NOT APPROVED**, per [Minu #6832724919](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832724919). [SQL-01 disposition #6832990843](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832990843) resolves the S1 cascade hypothesis only for the reproduced graph; distinct hard-delete policy and SQL-02–04 remain open. See the [current SQL outcome](proposals/issue-69-a/SQL_REVIEW.md). Architecture acceptance is unchanged; no migration/application release follows.

## ADR-024 — Compatible audit paging and fatal-process safety

- **Status:** ARCHITECTURE ACCEPTED; implementation NOT authorized by this record.
- **Exact accepted contract:** [preserved CC-69-A-04 / ADR-024](proposals/issue-69-a/frozen/CC-69-A-04_ADR-024.md), [posted text #6831937795](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6831937795).
- **Independent acceptance:** [minu-the-reviewer #6832033899](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832033899).
- **Decision:** Opt-in exact PostgreSQL timestamp/UUID audit cursor, unchanged array and legacy before semantics, no multi-request snapshot promise; trusted stop uses fenced existing PAUSED state; narrow first-stop 409; Prisma/path redaction; transactional audit seam; handler-first heavy worker import; bounded best-effort fatal flush with accepted proposed default 2,000 ms, not a durability guarantee.
- **Conditions:** Real child-process import/stalled-sink fault injection, timer/redaction/tenant/cursor tests, cancellation/attempt fencing, no new workflow state and preserved safe reconciliation. No executed application verification is claimed.

## ADR-025 — OpenAI provider adapters and paid dispatch policy

- **Status:** IMPLEMENTATION AUTHORIZED for PR2 of issue #65; production live smoke and release remain owner-approved gates.
- **Decision:** OpenAI is the first real provider for all required AI capabilities: text (`OPENAI_TEXT_MODEL`, default `gpt-4.1-mini`) for idea, script, quality and insight; images (`OPENAI_IMAGE_MODEL`, default `gpt-image-1`); speech (`OPENAI_TTS_MODEL`, default `gpt-4o-mini-tts`); and asynchronous video (`OPENAI_VIDEO_MODEL`, default `sora-2`). No vendor fallback or silent model substitution is permitted. The adapters use the existing provider-neutral ports and remain unconfigured unless `OPENAI_API_KEY` is non-empty.
- **Budget and idempotency:** Every adapter call remains behind the existing service-owned M18 `reservePaidCall` and M08 ledger/`finishPaidCall` sequence. The reservation key remains `m08:<correlationId>`; replay is a 409 and no automatic paid retry is performed. An asynchronous video retry resumes the persisted provider job rather than submitting a second job.
- **Timeouts:** Text requests are bounded at 60 seconds, image at 120 seconds, TTS at 60 seconds, video submission at 30 seconds, video polling at 5-second intervals, and video overall at 15 minutes. A dispatched timeout is uncertain and is charged at the preflight estimate.
- **Cost and limits:** Capabilities advertise conservative USD minor-unit estimates for preflight (`2` text, `10` image, `1` TTS, `100` video) until provider usage reconciliation is available. Provider responses must be schema/media/provenance validated; adapters never fabricate IDs, bytes, or success.
- **Testing and secrets:** Ordinary tests use fake HTTP transports only. Startup, health, CI and migrations never call OpenAI. `LIVE_AI_SMOKE=1` plus a real key is required for the manual smoke script, which has a hard cap and is excluded from `pnpm test` and CI. Keys are read only from environment and never logged or committed.
- **Consequence:** OpenAI can be enabled capability-by-capability by setting the shared key and explicit model variables. When the key is absent, existing `NotConfigured*` bindings and honest unavailable behavior remain unchanged.

### Issue #69(A) incorporation and remaining authority

[Manager A-DOC-01](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832566412) authorizes only this documentation route. Architecture acceptance is not a GitHub PR APPROVE or final application Gate 0 release. Reviewed documentation incorporation, separate exact-SQL acceptance, shared-contract coordination with #65, and final Manager owned-path/application release remain required. ADR-020 is reserved for Workstream E; its omission here is intentional. PROJECT_STATE, WORK_LOG and package STATUS are not changed by this incorporation.
