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

## Pending decisions before affected implementation

These are implementation-specific choices, not permission to invent behavior:

1. **Actual AI provider vendors/models:** select only after capability, commercial terms, region/data handling, output rights, quality, rate limits, and cost are compared. M08/M09 must not claim a provider is supported before this review.
2. **Email sender:** choose only if email notifications are enabled; in-app notifications can ship independently.
3. **Hosting/cloud region and production KMS:** confirm before production deployment.
4. **Data retention durations:** owner must approve retention/deletion policy before production media/analytics data accumulates.

Each pending decision must be resolved in an ADR before the affected production block is approved.
