# M19-T01 Security baseline

This is a baseline and hardening record, not a rewrite of M01 (identity) or M04 (assets). It lists the
controls that exist today, where they live, and how M19 checks them. Anything marked **gap** is a known
limit, not a claim of coverage.

## Secrets
- Secrets come from the environment only (`.env` is git-ignored; `.env.example` holds placeholders).
  ADR-007/ADR-010: no live provider credentials in tests, CI, startup, seed, or health checks.
- Passwords: scrypt with a per-user salt (`identity/auth.crypto.ts`), constant-time comparison, and a
  dummy hash for unknown emails. Session tokens are random and stored only as SHA-256 hashes; the
  `reelforge_session` cookie is `httpOnly`, `sameSite=strict`, `secure` in production.
- OAuth refresh tokens and resumable publishing session URIs are encrypted at rest with AES-256-GCM
  (`social-accounts/token-vault.ts`, `publishing/publishing-session-vault.ts`) using a key from the
  environment. **Gap:** production KMS/envelope encryption is still a pending DECISION_LOG item.
- M19 redaction (`packages/observability/src/redaction.ts`) applies to every structured log line and,
  after `bootstrapProcessObservability`, to `console.*` and the Nest framework logger in the API and
  worker. It removes values under secret-looking keys (password, token, secret, authorization, cookie,
  api key, private key, credential, ciphertext, signature, session/upload/signed URLs, storage keys,
  file paths), reduces every URL to `scheme://host/[REDACTED]` (so signed media URLs and query tokens
  never reach logs), and masks Bearer tokens, JWTs, Google `ya29.`/`1//` tokens, `key=value` secrets,
  the session cookie, and the literal values of configured secret env vars. Since the R1 fix it also
  masks JSON/YAML-style secrets in free text (`"access_token":"…"`, `client_secret: …`, escaped JSON).
- Since the R2 fix, `uncaughtException` and `unhandledRejection` in the API and worker are logged
  through the redacting logger at `fatal` (`installProcessErrorHandlers`) and the process exits 1.
- Since the R5 fix, the `/ops/metrics` token is compared as SHA-256 digests (`secretsEqual`), so the
  comparison leaks neither content nor length.

## RBAC (ADR-003)
- Roles are OWNER / EDITOR / VIEWER per workspace. Every workspace route resolves its context through
  `WorkspaceService.context`, which verifies membership (403 otherwise) before any query.
- M19 adds no role. Admin views, the audit log, and setting/clearing an emergency stop are **OWNER**
  actions; any member may read the stop status (so editors understand why work paused).
- Route guard baseline: `admin.http.integration.test.ts` walks every controller registered in
  `AppModule` and fails if a route without `AuthGuard` is not on the documented allowlist
  (`/health`, `/auth/register`, `/auth/login`, the state-bound OAuth callback, and the token-gated
  `/ops/metrics`). Adding a public route therefore needs a deliberate allowlist change.

## Tenant isolation
- All tenant rows carry `workspace_id`; earlier modules use composite `(workspace_id, id)` keys and
  scoped queries (architecture §8). M19 tables follow that: `emergency_stops` has composite FKs to
  the workspace and `(workspace_id, channel_id)`; admin queries always filter by the verified
  workspace id. `audit_events` is filtered by `workspace_id` on read.
- Tests: other-workspace OWNER gets 403 on every admin route; a channel stop for another tenant's
  channel is 404; failed-job views never include another tenant's run; scoped stops do not leak.

## Input validation
- Request bodies are parsed with Zod in each module (M19's admin query/stop bodies too); route ids
  are UUID-checked. Correlation ids from clients are accepted only when they are UUIDs, and a W3C
  `traceparent` only when well-formed; anything else is replaced.
- The audit interceptor never stores request bodies, query strings, or emails; route ids are kept
  only when they are UUIDs (plus the platform enum).

## Upload controls (M04)
- Uploads are base64 JSON bodies capped by `ASSET_MAX_BYTES` (positive-integer env, with a default).
  `asset/asset.validation.ts` rejects empty or oversized files, allows only image/png, image/jpeg,
  image/webp, audio/mpeg, audio/wav and video/mp4, checks the file content against the declared type,
  bounds filenames (200 characters, visible characters only), and requires rights metadata. Stored
  assets carry a SHA-256 checksum. The storage driver is local only; `s3` fails closed until an adapter
  is approved. M19 does not change these controls.

## Operational controls added by M19
- Append-only `audit_events` (T02), structured logs/metrics/traces with redaction (T03), liveness and
  readiness probes with no provider calls (T04), OWNER admin views (T05), emergency stop (T06).
