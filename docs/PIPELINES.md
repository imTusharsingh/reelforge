# Canonical Pipelines and State Machines

This file defines the v1 end-to-end behavior. Individual modules implement their assigned steps; the Orchestrator coordinates them. A UI button and a scheduled run must call the same application workflow, not separate business logic.

## 1. Generation pipeline

```text
Manual trigger OR scheduler tick
  -> verify workspace/channel access and channel is active
  -> load immutable channel/series/config/prompt snapshot
  -> check schedule, per-channel concurrency, budget reservation, and approval policy
  -> select user-approved idea OR request ideas from M06
  -> topic similarity / cooldown validation
  -> create approved idea snapshot
  -> generate structured script and storyboard (M07)
  -> validate schema, duration, genre policy, character references, factuality requirements
  -> create per-scene generation jobs (M09)
  -> call only registered real providers with valid credentials and budget
  -> store scene assets, provider job IDs, metadata, costs, and checksums
  -> assemble final video with FFmpeg (M10)
  -> deterministic media and rights checks (M11)
  -> structured AI review with evidence (M11)
  -> if hard gate fails: reject or route to bounded regeneration
  -> if score below threshold: request review/regeneration per channel policy
  -> default: human review queue
  -> approval decision stored with reviewer/time/reasons
  -> approved video becomes READY_TO_SCHEDULE
  -> publish scheduler or user schedules it (M13)
```

## 2. Publishing pipeline

```text
Scheduled post due OR user clicks Publish
  -> verify channel active, workspace authorization, account connected
  -> verify final video exists, checksum matches, media profile matches destination
  -> verify hard gates passed and approval policy satisfied
  -> validate metadata and current platform capability/permission
  -> acquire budget/quota reservation and publish idempotency key
  -> persist upload attempt before external side effect
  -> invoke platform adapter (official API only)
  -> persist remote ID, platform response metadata, status, and timestamps
  -> reconcile asynchronous processing/publishing status
  -> on uncertain timeout, query/reconcile before retrying
  -> schedule analytics collection windows supported by platform
  -> emit PostPublished / PublishFailed event
```

No upload occurs during app startup, OAuth callback, test discovery, page load, seed, health check, or ordinary CI.

## 3. Analytics and learning pipeline

```text
Analytics schedule
  -> load connected account and platform metric capability catalog
  -> check permissions and reporting window
  -> query official API for currently supported metrics
  -> normalize values and units; preserve raw source response metadata safely
  -> store immutable metric snapshots with period + collection time + completeness
  -> compute KPIs only when denominators and required data exist
  -> compare against valid historical baseline and minimum sample size
  -> produce descriptive report and evidence-linked AI insights
  -> store recommendations with confidence/limitations and source snapshot IDs
  -> user approves recommendation
  -> create new config/prompt version (never mutate historical snapshot)
  -> future content planning uses approved version
```

Missing data is not zero. A partial API response is marked partial. An unavailable metric is not inferred from another metric.

## 4. Daily report pipeline

```text
Daily report scheduler
  -> collect successful/failed workflow runs
  -> collect generated/reviewed/published counts
  -> collect verified analytics for the report window
  -> collect spend/budget status
  -> include top post only when data supports comparison
  -> add AI summary with evidence references and uncertainty
  -> persist report snapshot
  -> notify according to user preferences
```

## 5. Canonical state machines

### Video production state

`IDEA_PENDING -> IDEA_APPROVED -> SCRIPT_PENDING -> SCRIPT_READY -> GENERATION_PENDING -> GENERATING -> ASSEMBLING -> QA_PENDING -> REVIEW_REQUIRED -> APPROVED -> READY_TO_SCHEDULE`

Terminal/exception states: `REJECTED`, `FAILED`, `CANCELED`, `ARCHIVED`.

State transitions must be enforced server-side. A video cannot jump directly from `GENERATING` to `APPROVED`.

### Scene state

`QUEUED -> SUBMITTED -> PROVIDER_PROCESSING -> SUCCEEDED`.

Exception states: `RETRY_WAIT`, `FAILED_RETRYABLE`, `FAILED_FINAL`, `CANCELED`.

### Publish state (per destination)

`DRAFT -> SCHEDULED -> PREFLIGHT -> UPLOADING -> REMOTE_PROCESSING -> PUBLISHED`.

Exception states: `FAILED_RETRYABLE`, `FAILED_FINAL`, `CANCELED`, `RECONCILIATION_REQUIRED`.

### Workflow state

`CREATED -> QUEUED -> RUNNING -> WAITING_APPROVAL -> SUCCEEDED`.

Exception/paused states: `PAUSED`, `RETRY_WAIT`, `FAILED`, `CANCELED`.

## 6. Required event envelope

Every event must include:

- `eventId` (unique ID)
- `eventType` (registered, versioned name)
- `eventVersion`
- `occurredAt` (UTC timestamp)
- `workspaceId`
- `channelId` where relevant
- `correlationId`
- `causationId` where relevant
- `aggregateType` and `aggregateId`
- `payload` validated against a versioned schema

Do not include secrets, raw tokens, private signed URLs, or unnecessary personal data.

## 7. Idempotency and retry rules

- Every generation request uses a stable idempotency key based on workflow run, scene/version, provider, and generation attempt policy.
- Every publish request uses a stable key per video + destination account + intended publication revision.
- A worker must persist the side-effect intent before external execution.
- If the network times out after a possible success, mark `RECONCILIATION_REQUIRED`, query the destination, and only retry when duplicate side effect risk is resolved.
- Retry only known transient errors. Do not retry invalid permissions, invalid media, invalid metadata, insufficient budget, or permanent policy violations.
- Retry limits and backoff are configuration values with safe defaults and a hard maximum.

## 8. Scheduler safety

- Schedules are interpreted in each channel's IANA timezone.
- Daylight-saving transitions must be tested.
- Paused/archived channels are skipped and logged.
- Budget exhaustion prevents paid generation jobs from dispatching.
- Human approval is required unless channel policy explicitly enables auto-publish.
- No scheduled process can bypass the same preflight gates used by manual publishing.
