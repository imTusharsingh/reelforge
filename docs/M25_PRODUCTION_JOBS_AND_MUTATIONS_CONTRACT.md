# M25 production discovery and safe scene mutation contract — Core fix

**Branch:** `fix/core-60-production-job-contracts`  
**Consumer:** M25 Generation Studio & Video Production UI (issue #58)  
**Issue:** Core #60  
**Date:** 2026-11-12

## Why this is a separate Core change

M25 needs complete production-job history and safe paid mutations before it can enable generation controls. The previous API exposed `GET /scene-media/jobs/:jobId` but no workspace list; direct scene jobs without usage-ledger rows were not discoverable. `POST /scene-media/jobs` did not require an observed approved script revision, and retry/regenerate/replace planned from the current approved script while the job remained pinned to older snapshot IDs. Mutations had no client operation key or observed-version precondition.

This change implements those shared/backend contracts only. It does not implement M25 UI, add provider integrations, select vendors/models, perform live provider calls, or infer scene cancellation. It does not implement #59 media delivery.

**Core ownership:** issue #60 authorizes this Core session to change shared contracts and additive database schema/migrations for this scope.

## Added and changed routes

All routes use the existing authenticated workspace context. Reads require current workspace membership (`OWNER`, `EDITOR`, or `VIEWER`). Writes require `OWNER` or `EDITOR`. Cross-workspace IDs are not resolved.

| Method | Route (relative to `/api/v1/workspaces/:workspaceId`) | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/scene-media/jobs?scriptId=&channelId=&status=&page=&pageSize=` | Viewer+ | Complete scene-media job history |
| GET | `/scene-media/capabilities` | Viewer+ | Server-derived capability availability |
| POST | `/scene-media/jobs` | Owner/Editor | Create a job pinned to an observed approved revision |
| POST | `/scene-media/jobs/:jobId/retry` | Owner/Editor | Idempotent retry from pinned inputs |
| POST | `/scene-media/jobs/:jobId/scenes/:sceneId/regenerate` | Owner/Editor | Idempotent scene regeneration |
| POST | `/scene-media/jobs/:jobId/scenes/:sceneId/replace` | Owner/Editor | Idempotent output regeneration |
| GET | `/composition/jobs?scriptId=&channelId=&status=&page=&pageSize=` | Viewer+ | Complete render-job history |

Existing `GET /scene-media/jobs/:jobId`, export, provider-health and composition routes are unchanged except that scene-media packages now include `version`.

## Scene-media job discovery

`GET /scene-media/jobs` reads persisted `scene_media_jobs` rows directly. It does not depend on usage ledger lines, workflow result references, or provider-request rows, so a direct job with no ledger row is discoverable.

Query fields:

- `scriptId` (UUID, optional)
- `channelId` (UUID, optional)
- `status` (`QUEUED`, `RUNNING`, `SUCCEEDED`, `PARTIAL`, `FAILED`, optional)
- `page` (integer, default 1, max 10,000)
- `pageSize` (integer, default 25, max 100)

Unknown query fields are rejected. Results are ordered by `createdAt DESC, id DESC` for stable pagination.

Response:

```json
{
  "items": [
    {
      "jobId": "uuid",
      "workspaceId": "uuid",
      "scriptId": "uuid",
      "scriptRevision": 3,
      "channelId": "uuid-or-null",
      "status": "SUCCEEDED",
      "version": 2,
      "idempotencyKey": "client-key",
      "configSnapshotId": "uuid",
      "promptSnapshotId": "uuid",
      "requestedOutputs": {
        "image": true,
        "video": false,
        "narration": true,
        "dialogue": false
      },
      "createdAt": "2026-11-12T00:00:00.000Z",
      "updatedAt": "2026-11-12T00:00:01.000Z"
    }
  ],
  "page": 1,
  "pageSize": 25,
  "nextPage": null
}
```

`nextPage` is `null` on the last page. The response never contains prompt text, storage keys, provider secrets, or fabricated history.

## Pinned creation

`POST /scene-media/jobs` now requires:

```json
{
  "scriptId": "uuid",
  "expectedScriptRevision": 3,
  "idempotencyKey": "client-key",
  "outputs": {
    "image": true,
    "video": false,
    "narration": true,
    "dialogue": false
  }
}
```

The server reads the script inside the workspace and requires:

- script status is `APPROVED`;
- `expectedScriptRevision` equals the script's current revision;
- that exact revision exists;
- the revision has an owned configuration/prompt snapshot pair;
- the prompt snapshot belongs to the configuration snapshot and its fingerprint matches.

A stale observed revision, unapproved script, missing revision, or mismatched snapshot pair returns HTTP 409 before any provider dispatch. The new job pins `scriptRevision`, `configSnapshotId` and `promptSnapshotId` from that exact revision.

Replaying the same create key with the same script revision and outputs returns the existing package. Reusing the key with a different script revision or output set returns HTTP 409.

## Mutation version token and idempotency

Every scene-media package now includes `version`. A newly created job starts at `version: 1`. Each accepted retry/regenerate/replace claim increments the job version exactly once, whether the subsequent dispatch succeeds or fails.

Mutation requests require an observed version and a client operation key:

```json
{
  "idempotencyKey": "retry-2026-11-12-a",
  "expectedJobVersion": 1
}
```

`POST .../replace` additionally requires `kind` (`IMAGE`, `VIDEO`, `NARRATION`, or `DIALOGUE`):

```json
{
  "idempotencyKey": "replace-image-2026-11-12-a",
  "expectedJobVersion": 2,
  "kind": "IMAGE"
}
```

Semantics:

- The claim is atomic: the job version is compared and incremented in one transaction before any paid work. A stale or concurrently claimed version returns HTTP 409.
- The claim also takes a job-scoped in-flight lease (`leaseId` + `leaseExpiresAt`). Initial creation takes the lease before dispatch, so a mutation cannot start while the create operation is still running. A different-key mutation observed at the newly incremented version returns HTTP 409 while paid work is active.
- A key is scoped to workspace, job, and operation payload. The payload hash covers operation, expected version, target scene and output kind.
- Same key with the same payload and a `SUCCEEDED` mutation returns the current package without dispatching paid work again.
- Same key with a different payload returns HTTP 409.
- Same key while the mutation is `IN_PROGRESS` returns HTTP 409. Clients must observe the job rather than start duplicate work.
- Same key after a `FAILED` mutation returns HTTP 409. Clients must use a new key after resolving the failure.
- A failed mutation still consumes its version. Clients must reload the package before retrying.
- The lease has a 30-minute expiration window and is renewed every 15 seconds during a live create or mutation. The owner token is checked before paid dispatch and transactionally fenced before scene and output writes; a stale owner cannot commit new scene/asset/job state after ownership loss.
- An expired lease is **not** proof that a provider stopped processing: if an active scene is still `PROVIDER_PROCESSING`, takeover fails with HTTP 409 and requires explicit provider reconciliation before further paid dispatch. This can require manual/operator action until provider-specific reconciliation is implemented. If no provider work is unresolved, a subsequent claim can take over and reconcile old `IN_PROGRESS` mutations to `FAILED` with `STALE_OPERATION`.
- The heartbeat only protects this synchronous request lifetime. Future asynchronous vendors must persist external provider-job IDs and provide reconciliation/leases across worker restarts; do not present async vendor integrations as safe solely because the HTTP request uses a heartbeat.

Mutations plan from the job's pinned `scriptRevision`, `configSnapshotId` and `promptSnapshotId`. If that revision is missing or its snapshot IDs no longer match the job, the mutation fails with HTTP 409 instead of planning from a newer script.

`SceneMediaMutation` rows are persisted for reconciliation:

- `operation`: `RETRY`, `REGENERATE`, `REPLACE`
- `status`: `IN_PROGRESS`, `SUCCEEDED`, `FAILED`
- `expectedJobVersion`, `payloadHash`, `payload`
- `sceneIds`, `sceneVersionBefore`, `sceneVersionAfter`
- optional `errorCode` / `errorMessage`

Unique key: `(workspaceId, jobId, idempotencyKey)`.

## Replace semantics

`POST .../scenes/:sceneId/replace` with `{ kind }` regenerates that output for the scene. It does **not** assign an existing library asset and it does not relabel an output kind. The request shape is unchanged in meaning; the new key/version fields make the paid regeneration safe.

A future selected-asset assignment contract would need, at minimum:

- a new operation kind (for example `ASSIGN`);
- `assetId` + immutable `assetVersion` and `expectedJobVersion`;
- workspace ownership, `PUBLISHED` status, media-type/kind compatibility, rights/license and checksum validation;
- a new scene generation version without a provider call;
- the same idempotency and conflict rules.

That contract is **not implemented**. It is recorded as a proposal and requires separate Core approval before M25 can enable asset selection.

## Capability availability

`GET /scene-media/capabilities` returns server-derived registration metadata only. It does not perform a live health probe, expose secrets, list models, or claim a vendor is healthy.

```json
{
  "workspaceId": "uuid",
  "generatedAt": "2026-11-12T00:00:00.000Z",
  "environment": "production",
  "capabilities": [
    {
      "kind": "IMAGE",
      "available": false,
      "reason": "PROVIDER_NOT_CONFIGURED",
      "message": "Image generation is not configured.",
      "providerId": null,
      "capabilityId": null
    }
  ]
}
```

Kinds are always `IMAGE`, `VIDEO`, `NARRATION`, `DIALOGUE`. Unavailable reasons are:

- `PROVIDER_NOT_CONFIGURED`
- `CAPABILITY_NOT_REGISTERED`
- `CAPABILITY_MISMATCH`
- `PROVIDER_ENVIRONMENT_MISMATCH`
- `COST_UNKNOWN`

With the default NotConfigured adapters, image/video/TTS remain unavailable and report `PROVIDER_NOT_CONFIGURED`. `providerId`/`capabilityId` are populated only when a capability is actually registered for the current environment; they are never used as request inputs.

## Render-job discovery

`GET /composition/jobs` reads persisted `render_jobs` rows joined to their scene-media job for script/channel filters. It does not depend on usage ledger rows.

Response items include `jobId`, `workspaceId`, `sceneMediaJobId`, `scriptId`, `scriptRevision`, `channelId`, `status`, `attempt`, `idempotencyKey`, `inputFingerprint`, `parentJobId`, `retentionDays`, `cancelRequestedAt`, `errorCode`, `errorMessage`, `artifactCount`, `createdAt`, `updatedAt`, `expiredAt`, plus `page`, `pageSize`, `nextPage`. Pagination and filter rules match scene-media discovery.

## State transitions

Scene-media job discovery status continues to use the persisted `SceneMediaJobStatus` (`QUEUED`, `RUNNING`, `SUCCEEDED`, `PARTIAL`, `FAILED`). The mutation version is independent of execution status and only changes on an accepted mutation claim.

Mutation reconciliation:

```text
(none) --claim--> IN_PROGRESS --dispatch success--> SUCCEEDED
                             \--dispatch failure--> FAILED
```

A replay never moves a mutation back to `IN_PROGRESS` and never re-dispatches a `SUCCEEDED` mutation.

There is no scene cancellation endpoint. `CANCELED` exists only on render-job status and is not extended to scenes.

## Compatibility

- Discovery and capabilities are additive routes.
- `SceneMediaPackage.version` is an additive response field.
- `POST /scene-media/jobs` now requires `expectedScriptRevision`; older callers receive HTTP 400. The M16 orchestration consumer was updated to read the approved script revision and pass it.
- Retry/regenerate/replace now require a JSON body with `idempotencyKey` and `expectedJobVersion`; older callers receive HTTP 400.
- `scene_media_jobs.version` is additive with default `1`, so existing rows remain valid.
- `scene_media_jobs.active_operation_id` and `active_operation_expires_at` are nullable additive columns. Existing jobs have no lease and can be mutated immediately.
- `scene_media_mutations` and its enums are new. Migrations `20261120010000_m25_production_jobs_and_mutations` and `20261120020000_m25_scene_media_operation_lease` are additive only and must be applied before deploying this server code.
- Prisma client generation is required in the normal build process.

## Verification and release gates

Focused coverage includes direct-job discovery without ledger rows, script/channel/status filters, bounded pagination, tenant isolation, Viewer reads, stale approved revisions, pinned historical revisions and snapshots, stale/concurrent job versions, same-key replay, same-key different-payload conflicts, ambiguous-response replay without duplicate paid work, capability reasons, and render-job discovery. PostgreSQL coverage holds the first dispatch open and proves that a different-key mutation at the newly observed version and a mutation during initial `RUNNING` creation are rejected without a second provider dispatch; it also covers expired-lease recovery and stale-mutation reconciliation.

No live AI or social calls are made by tests. Provider fixtures are local test seams only.

## M25 handoff

M25 should:

- use `GET /scene-media/jobs` and `GET /composition/jobs` for history instead of workflow references or cost lines;
- send the observed `script.currentRevision` as `expectedScriptRevision` on create;
- carry the returned package `version` into every retry/regenerate/replace request with a fresh client operation key;
- treat HTTP 409 as “reload and compare”, never as an invitation to reuse the same key with a different body;
- display capability reasons from `GET /scene-media/capabilities`, including NotConfigured;
- keep selected-asset assignment and scene cancellation disabled until separate approved contracts exist.

Issue #59 media delivery remains independent and is not implemented here.
