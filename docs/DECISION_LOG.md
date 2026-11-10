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

## Pending decisions before affected implementation

These are implementation-specific choices, not permission to invent behavior:

1. **Actual AI provider vendors/models:** select only after capability, commercial terms, region/data handling, output rights, quality, rate limits, and cost are compared. M08/M09 must not claim a provider is supported before this review.
2. **Email sender:** choose only if email notifications are enabled; in-app notifications can ship independently.
3. **Hosting/cloud region and production KMS:** confirm before production deployment.
4. **Data retention durations:** owner must approve retention/deletion policy before production media/analytics data accumulates.

Each pending decision must be resolved in an ADR before the affected production block is approved.
