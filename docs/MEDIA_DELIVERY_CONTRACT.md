# Authorized Media Delivery Contract (Core #59)

- **Status:** Core decision for issue #59; implemented by the Core media-delivery work package.
- **Scope:** Backend/shared API contract only. M25 consumes this contract; M25 frontend work and issue #60 are out of scope.
- **Source audit:** `main` at `7a81e0710b4c1ff6ae1375aacb3ef6d89634db0e` after PR #55, plus the M25 capability audit on `feat/m25-generation-studio`.
- **Schema change:** None. Existing `Asset`, `RenderJob`, and `RenderArtifact` rows already carry immutable identity, byte size, checksum, media type, object key, and retention data.

## Decision

Media bytes are delivered **through the authenticated API** using the existing `StoragePort` abstraction. The API resolves the exact immutable asset version or render artifact inside the verified workspace, re-checks state and integrity, then streams the stored bytes.

This deliberately rejects:

- converting `objectKey` into an assumed public URL;
- arbitrary URL fetching or redirects to storage;
- public bucket/CDN bypasses;
- signed URLs that outlive authorization or retention;
- fabricated media, metadata, or success.

Authenticated byte streaming is the only delivery mode implemented. A future S3-compatible adapter may add server-side range reads, but it must preserve this contract and authorization boundary.

## Endpoints

All paths are relative to the global `/api/v1` prefix and require a verified session plus current workspace membership.

### 1. Immutable asset-version content

```http
GET  /api/v1/workspaces/:workspaceId/assets/:assetId/versions/:version/content
HEAD /api/v1/workspaces/:workspaceId/assets/:assetId/versions/:version/content
```

- `:assetId` is either the exact version row ID or the root asset ID.
- `:version` is a required positive integer. There is no implicit "latest" content route.
- The service resolves exactly `(workspaceId, assetId-or-rootAssetId, version)`.
- Only `PUBLISHED` assets with checksum, byte size, and an allowlisted media type are delivered.
- Bytes are read from `StoragePort.getObject` using the persisted workspace and object key, then verified against the persisted byte size and SHA-256 checksum before any response body is written.

### 2. Render-artifact content

```http
GET  /api/v1/workspaces/:workspaceId/composition/jobs/:jobId/artifacts/:artifactId/content
HEAD /api/v1/workspaces/:workspaceId/composition/jobs/:jobId/artifacts/:artifactId/content
```

- `:artifactId` is the immutable `RenderArtifact.id` returned in `RenderJobView.artifacts`.
- The service binds the artifact to the same workspace and `jobId`.
- The job must be `SUCCEEDED`, `expiredAt` must be null, and the artifact `retainedUntil` must be null or in the future.
- The artifact must still match its persisted asset row (`assetId`, `assetVersion`, `objectKey`, `mediaType`, `byteSize`, `checksumSha256`) and its object key must stay under `render/<jobId>/`.
- Bytes are read from `StoragePort.getObject` and verified against the artifact checksum and size before any response body is written.

## Request contract

### Path parameters

| Parameter | Rule |
| --- | --- |
| `workspaceId` | UUID; membership is verified by `WorkspaceService.context`. |
| `assetId` | UUID; exact version ID or root asset ID. |
| `version` | Positive integer; required for asset content. |
| `jobId` | UUID; render job in the verified workspace. |
| `artifactId` | UUID; render artifact in that job. |

### Query parameters

| Parameter | Values | Default | Meaning |
| --- | --- | --- | --- |
| `download` | `true` or `false` | `false` | `true` forces `Content-Disposition: attachment`; otherwise media is `inline`. Unknown values are rejected with `400`. |

No other query parameter changes authorization, storage location, media type, or filename. Malformed `version` or `download` values are rejected with `400` before resource bytes are read.

## Response contract

### Success headers

| Header | Value |
| --- | --- |
| `Content-Type` | Persisted allowlisted media type only. |
| `Content-Length` | Full byte size, or selected range length for `206`. |
| `Content-Disposition` | `inline` or `attachment` with a sanitized RFC 5987 filename. |
| `X-Content-Type-Options` | `nosniff` |
| `Accept-Ranges` | `bytes` |
| `ETag` | `"sha256-<64 hex>"` |
| `Cache-Control` | Asset versions: `private, max-age=31536000, immutable`; render artifacts: `private, no-store`. |
| `Content-Range` | Present on `206` and `416` only. |

Asset versions are immutable and non-expiring, so browsers may cache them privately for a year. Render artifacts can expire and their bytes can be deleted by retention, so they are never stored in a shared or persistent HTTP cache.

### Status codes

| Status | When |
| --- | --- |
| `200` | Full content, or `HEAD` metadata. |
| `206` | Valid single byte range. |
| `400` | Malformed UUID/version/query value. |
| `401` | Missing or invalid session. |
| `403` | Session is valid but current workspace membership is absent or the workspace is archived. |
| `404` | Asset version, render job, or artifact is not found in the verified workspace; or the persisted object is missing. |
| `409` | Asset is not `PUBLISHED`; render is not `SUCCEEDED`; artifact binding/metadata is invalid; or stored bytes fail checksum/size integrity. |
| `410` | Render or artifact retention has expired. |
| `416` | Requested byte range is malformed, multiple, or unsatisfiable. |
| `503` | Storage read failed for a reason other than a missing object. |

Cross-tenant resources return `404` after workspace membership succeeds, so the API does not reveal that another tenant's asset or render exists. A caller with no membership in the path workspace gets `403` before resource lookup.

## Range semantics

- Supported: one range only, in `bytes=start-end`, `bytes=start-`, or `bytes=-suffix` form.
- End offsets beyond the object are clamped to the last byte.
- Unsatisfiable, malformed, or multiple ranges return `416` with `Content-Range: bytes */<size>`.
- `If-Range` is honored for the exact `ETag` value. If it does not match, the full `200` representation is returned instead of a partial response.
- `HEAD` returns full representation headers with no body; range headers do not produce a body.

## Consumer contract for M25

M25 must build these paths from persisted identifiers and must not construct storage URLs.

```ts
// Asset gallery / scene asset preview
const assetContentPath =
  `/api/v1/workspaces/${workspaceId}/assets/${asset.id}/versions/${asset.version}/content`;

// Render preview/download
const artifactContentPath =
  `/api/v1/workspaces/${workspaceId}/composition/jobs/${renderJob.id}/artifacts/${artifact.id}/content`;

// Force a download instead of inline playback
const downloadPath = `${artifactContentPath}?download=true`;
```

`RenderJobView.artifacts` already exposes `id`, `kind`, `mediaType`, `byteSize`, `checksumSha256`, and `retainedUntil`. `AssetRecord` already exposes `id`, `version`, `rootAssetId`, `mediaType`, `byteSize`, and `checksumSha256`. No new response DTO fields are required.

Recommended M25 behavior:

- Use `artifact.kind === "VIDEO"` for video preview and `"COVER"` for poster/thumbnail.
- Treat `404`, `409`, and `410` as explicit unavailable states; do not retry them as transient network errors.
- Use `ETag`/`Content-Range` from the browser's native media element; do not implement a second byte-range protocol in the UI.
- Do not cache render-artifact URLs as permanent public links. Re-request `RenderJobView` after a `410`.

## Limits and known gaps

- The current `StoragePort` returns a full `Buffer`; this contract verifies the whole object before serving a range. Large render memory use is bounded by the existing render size, but a future storage adapter should add server-side range reads while preserving checksum/state checks.
- Multi-range requests are rejected rather than multipart-encoded.
- No transcoding, thumbnailing, watermarking, or format negotiation is performed.
- No public/signed URL is issued.
- Retention durations remain the existing per-render `retentionDays` and the pending owner retention decision in `docs/DECISION_LOG.md`; this contract does not invent a new duration.
- The local filesystem adapter is the only runtime storage adapter on `main`. Selecting an unimplemented driver still fails loudly.
