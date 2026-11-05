# Architecture Baseline

## 1. Architecture style

Use a **modular monolith with separately deployed API and worker processes**. Do not start with microservices. Each domain module owns its application logic and internal persistence adapter, but shared public contracts are centrally governed.

```text
Next.js Web App
      |
      v
NestJS API  <----> PostgreSQL (Prisma)
      |                    ^
      |                    |
      v                    |
Redis / BullMQ ------------+
      |
      v
Worker Process
  |-- content/LLM jobs
  |-- image/video/voice jobs
  |-- FFmpeg render jobs
  |-- quality jobs
  |-- publishing jobs
  |-- analytics jobs
  |-- report jobs
      |
      +---- Provider adapters (real external providers only when explicitly configured)
      +---- Social adapters (official OAuth/API only)
      +---- S3-compatible storage
```

## 2. Technology baseline

| Concern | Locked baseline |
|---|---|
| Language | TypeScript, strict mode |
| Monorepo | pnpm workspaces |
| Web | Next.js App Router |
| API | NestJS |
| Database | PostgreSQL |
| ORM | Prisma |
| Queue | Redis + BullMQ |
| Rendering | FFmpeg, invoked with argument arrays (never shell-concatenated untrusted input) |
| Storage | S3-compatible object storage; local filesystem adapter for development |
| Validation | Zod for shared runtime schemas; DTO validation at API boundaries |
| API documentation | OpenAPI generated from NestJS/DTO contracts |
| Logging | Structured JSON logs with correlation IDs |
| Observability | OpenTelemetry-compatible traces/metrics and health checks |
| Tests | Vitest or Jest consistently selected in M00; no mixed test framework per module |

The exact package versions must be pinned in lockfiles. A bot must not silently upgrade framework or major dependency versions.

## 3. Target repository ownership

- `apps/web`: UI routes, presentation, user interactions. It does not call provider SDKs directly.
- `apps/api`: authentication, authorization, request validation, domain commands/queries, and API responses.
- `apps/worker`: BullMQ processors and long-running workflows. No public ingress.
- `packages/contracts`: DTOs, event names, ports, schemas, status enums. Core-owned.
- `packages/database`: Prisma schema, generated client policy, migrations, seed policy. Core-owned.
- `packages/config-engine`: configuration merge/validation/versioning. Owned by M05.
- `packages/ai-providers`: provider-neutral model/image/video/voice interfaces and provider adapters. Owned by M08/M09 under common contracts.
- `packages/social-providers`: platform-neutral social adapter ports and platform-specific connectors. Owned by M12.
- `packages/media`: file metadata, validation, FFmpeg composition, thumbnail/subtitle helpers. Owned by M10.
- `packages/observability`: shared logging, metrics, tracing helpers. Owned by M19.

## 4. Domain boundaries

| Domain | Owns | Must not own |
|---|---|---|
| Identity/workspace | User identity, workspace membership, authorization context | Channel creative settings |
| Channel | Channel profile, goals, schedule, destination references | Social OAuth token internals |
| Genre/series | Content taxonomy, rules, series format | Prompt rendering code |
| Character/assets | Character identity, reference assets, asset rights metadata | Video generation provider calls |
| Config/prompt | Versioned config, inheritance, resolved snapshots, prompt template assembly | Calling LLMs or media APIs |
| Ideas/topics | Ideas, topic registry, similarity and duplicate decisions | Script content generation |
| Script/storyboard | Structured script, scene plans, revisions | Rendering media files |
| Provider/cost | Model capability registry, provider adapters, cost ledger | Channel policy decisions |
| Media generation | Generate media assets per scene | Final video composition |
| Composition | Compose/validate/export finished video | Social publishing |
| Quality/review | Deterministic checks, AI review, human decisions | Overriding hard safety gates |
| Social accounts | OAuth connection and platform API clients | Publishing schedule rules |
| Publishing | Post metadata, schedule, uploads, post status | Fetching all analytics history |
| Analytics | Metric definitions, snapshots, ingestion | Automatic changing of channel settings |
| Learning | Insights, experiments, recommendations | Executing unapproved changes |
| Orchestration | Job state, dependencies, retries, cancellation, schedules | Domain-specific AI prompt content |
| Notifications | Templates, delivery records, routing | Workflow state ownership |
| Usage/budget | Cost records, quotas, budget enforcement | Provider-specific SDK behavior |
| Admin/ops | Audit, observability, health, operational controls | User-facing creative functionality |

## 5. Shared contract policy

The Core Architect/Reviewer owns these files and approves all changes:

- `packages/contracts/**`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/**` (migration merge order)
- root `package.json`, `pnpm-workspace.yaml`, TypeScript base config, lint/test config
- event registry and cross-domain API schemas

A module bot that needs a contract or schema change must submit a `CONTRACT_CHANGE_PROPOSAL.md` or schema proposal. It must not edit shared contract files unilaterally. This is the main safeguard against parallel-session merge conflicts and incompatible assumptions.

## 6. Cross-module communication

- Synchronous reads/commands use internal application service interfaces or NestJS module exports.
- Long-running work uses typed domain events and BullMQ jobs.
- Every event has a versioned schema, producer, consumer, idempotency key, and retry/dead-letter policy.
- Do not use arbitrary string event names scattered through code.
- Avoid direct database access across module boundaries. Expose a service/port or read model.
- Avoid circular module imports. If two modules require each other, submit a boundary proposal to the Core Architect/Reviewer.

## 7. Configuration resolution

Effective configuration is resolved in this precedence order:

`platform defaults -> workspace defaults -> channel -> genre -> series -> character-specific rules -> individual video override`.

A higher layer may be locked by a higher-precedence policy. User additions are appended only to explicitly designated prompt sections and cannot override safety, platform, rights, or system constraints. Every generation job stores an immutable configuration snapshot ID and prompt-version IDs.

## 8. Multi-tenant isolation

All user-owned records are scoped to `workspace_id` (or an equivalent tenant key). Every repository query must receive a verified workspace context from authorization middleware. Use compound foreign keys/uniqueness where practical. Never trust a workspace ID sent by the client without membership verification. Add tests that prove cross-workspace reads and writes are denied.

## 9. Secrets and provider credentials

- Never store plain OAuth refresh tokens or provider API keys in ordinary application tables/logs.
- Store encrypted token material using a managed KMS/envelope encryption strategy in deployed environments; local dev uses a local secret key loaded from environment, never committed.
- Redact secrets, signed URLs, authorization headers, and personal data from logs.
- Tokens must be revocable and scoped to the minimum required permissions.

## 10. Reliability rules

- Every side-effecting job has an idempotency key.
- External upload requests persist an attempt record before execution and reconcile uncertain outcomes before retrying.
- Retries are bounded, exponential where appropriate, and only for retryable errors.
- Permanent provider/API errors move to a failed state with actionable diagnostics.
- Jobs must support cancellation or pause where technically possible.
- A worker restart must not silently duplicate an upload or generation charge.
- Store source asset IDs, model/provider version, prompt version, generation parameters, timestamps, and cost for every paid generation.
