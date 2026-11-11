# Core #56 — Atomic caller preconditions for planning writes

This document defines the required caller-version contract for M06 idea lifecycle writes and M07 script revisions/approval. It is a **breaking request-shape change** for these three write endpoints; deploy backend and update callers together. No schema migration is required.

## Request shapes

**PATCH** `/api/v1/workspaces/:workspaceId/ideas/:ideaId/status`

```json
{"status":"APPROVED","expectedStatus":"DRAFT","expectedUpdatedAt":"2026-11-11T10:00:00.000Z"}
```

Scheduling also requires `"scheduledAt":"<future ISO timestamp>"`. Both `expectedStatus` and offset-aware `expectedUpdatedAt` are mandatory. The server compares authenticated workspace, idea ID, last-seen status, last-seen timestamp and `archivedAt: null` in a *single conditional update*. Invalid/missing tokens return 400; missing idea returns 404; stale tokens or disallowed transition return 409. Approval snapshot creation and state update occur in one transaction. Rejections/backlog transitions also use the conditional update (no unconditional path).

**POST** `/api/v1/workspaces/:workspaceId/scripts/:scriptId/revisions`

```json
{"expectedRevision":1,"document":{"schemaVersion":"1.0","title":"...","hook":"...","dialogue":"...","cta":"...","metadata":{"genre":"...","targetDurationSeconds":10,"factual":false},"scenes":[{"id":"scene-1","startSeconds":0,"durationSeconds":10,"characterRefs":[],"dialogue":"...","visualDescription":"...","camera":"...","audioCues":[]}]}}
```

`expectedRevision` must be a positive integer and `document` must satisfy the existing full M07 document validation. The server verifies expected revision and performs a transactional conditional `currentRevision == expectedRevision` update plus immutable revision insertion. Stale preconditions return HTTP 409 with **no new revision**.

**POST** `/api/v1/workspaces/:workspaceId/scripts/:scriptId/approve`

```json
{"expectedRevision":1}
```

The server requires the exact revision observed by the approver and checks revision, nonapproved status and workspace in the conditional status update. Stale preconditions return 409 without approving an unseen revision; the returned approved export is bound to the expected revision. Invalid/missing token returns 400.

## Release and integration

1. Existing app/API clients must send the tokens they obtained from the last server read. Do not substitute a fresh preflight token for one previously observed by a user.
2. Refresh after 409, display differences and request explicit user resolution. Never automatically retry stale writes.
3. Keep M24 client/UI status/revision/approval gates closed until this Core PR is independently reviewed, merged, and an M24 integration PR supplies expected tokens and tests.
4. Both direct service callsites (unit/integration/orchestration) and HTTP callers must use the new shapes. Workspace and Editor/Viewer guards are retained.
5. No new migrations, provider registration, or paid model calls are part of this fix.
6. Verify formatting, lint, typecheck, production build, all unit and integration tests, and actual Postgres interleaving/no-mutation evidence in required CI.

Related: Core issue #56; UI PR #55; prerequisite PR #53.
