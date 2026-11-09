# M12 Status - Social Accounts & Platform Adapters

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Completion:** 100% of the assigned implementation; T05 intentionally ships a documented fail-closed Instagram connector rather than an unverified integration.
- **Assigned session/editor:** Module Implementation Agent (Desktop)
- **Branch/worktree:** `work/m12-social-accounts-and-platform-adapters`, PR #22; based on post-closeout `main` at `a0c12974c0f98f1041729bf7c3f1f4e5f33a4e73`
- **Last updated:** 2026-11-10
- **Reviewer:** Minu (Core Architect)
- **Approved commit:** none; implementation review is pending.

## Current objective
Provide workspace-scoped social-account connections, OAuth credential lifecycle, verified account identity, platform permissions/capabilities, and provider error normalization. No calendar, post approval, analytics, or publishing/upload execution is included.

## Task checklist
- [x] M12-T01: Add runtime-validated, platform-neutral account, permission, capability, and provider-error contracts.
- [x] M12-T02: Add OAuth state/CSRF protection, PKCE, callback validation, encrypted token storage, refresh, and revocation.
- [x] M12-T03: Add YouTube Data API v3 OAuth and authenticated channel identity via `channels.list(mine=true)`.
- [x] M12-T04: Enforce minimum scopes and handle token expiry/refresh.
- [x] M12-T05: Add the Instagram connector contract and explicit `NOT_CONFIGURED` path. No Instagram success path or live connector is claimed.
- [x] M12-T06: Normalize provider errors/rate limits, upload-session references, and remote media IDs without performing uploads.
- [x] M12-T07: Add workspace-scoped connection health and capability output; health checks use identity reads only.

## API and module interface
- `POST /workspaces/:workspaceId/channels/:channelId/social-accounts/:platform/connect` starts a selected-account OAuth flow.
- `GET /workspaces/:workspaceId/social-accounts` and `GET /workspaces/:workspaceId/social-accounts/:accountId` return token-free account views.
- `POST /workspaces/:workspaceId/social-accounts/:accountId/refresh`, `/health`, and `/revoke` require owner/editor membership.
- `GET /social-accounts/oauth/:platform/callback` is unauthenticated by design; it accepts only a valid, unexpired, one-use state bound to the initiating user, workspace, channel, and platform, then revalidates workspace membership and role.
- `@reelforge/api/social-accounts-service` exports the service for downstream modules. The authenticated client returns account capabilities and safe health/refresh operations; plaintext credentials are not part of the public contract.

## Security and persistence
- OAuth state is random, stored as a SHA-256 hash, expires after ten minutes, and is atomically consumed once. PKCE uses S256; the verifier is encrypted with context-bound AES-256-GCM.
- Access and refresh tokens are encrypted at rest with AES-256-GCM, per-secret nonces, and workspace/account/secret-specific AAD. Tokens are omitted from API responses and are not logged.
- Local/development configuration uses `SOCIAL_TOKEN_ENCRYPTION_KEY`: base64url encoding of exactly 32 random bytes, kept in ignored local environment configuration. YouTube OAuth also requires `YOUTUBE_OAUTH_CLIENT_ID`, `YOUTUBE_OAUTH_CLIENT_SECRET`, and `YOUTUBE_OAUTH_CALLBACK_URL`. Production KMS/key rotation remains an open Core decision; this is not a production KMS implementation.
- Owner/editor membership is required for connect, refresh, health mutation, and revoke. Viewer mutation is denied; all account queries and writes include workspace scope. Composite database foreign keys prevent cross-workspace account/token/state references.
- Additive persistence comprises `SocialAccount`, `SocialAccountToken`, `SocialAccountPermission`, `SocialAccountCapability`, `SocialOAuthState` and their M12 enums/indexes/foreign keys. The new migration contains only additive M12 objects; prior migrations and unrelated M00–M11 models were not changed.

## Provider documentation verified
Reviewed official documentation on 2026-11-10. YouTube uses Data API v3.

- YouTube OAuth/authentication, narrow-scope guidance, offline refresh, token endpoint, and revocation: [Google YouTube authentication](https://developers.google.com/youtube/data/guides/authentication).
- Authenticated identity endpoint and `mine=true`: [YouTube Data API v3 `channels.list`](https://developers.google.com/youtube/data/reference/rest/v3/channels/list). The connector requests only `id,snippet`, uses `mine=true`, and matches the selected channel ID.
- Future upload scope/endpoint reference only; upload is not implemented: [YouTube Data API v3 `videos.insert`](https://developers.google.com/youtube/data/reference/rest/v3/videos/insert). Current minimum requested scopes are `youtube.readonly` for identity and `youtube.upload` for the future upload capability; the connector fails closed if the token response does not prove those grants.
- Future resumable-session reference only; no upload is performed: [YouTube resumable upload protocol](https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol).
- Meta overview says Unified Login is recommended for new integrations; it supports professional accounts without a Facebook Page but requires a business portfolio and Meta app configuration: [Instagram Platform overview](https://developers.facebook.com/documentation/instagram-platform/overview) and [Instagram API with Unified Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login).
- Meta's Instagram Login business flow remains documented with updated `instagram_business_basic` and `instagram_business_content_publish` scopes; old scope names were deprecated effective 2025-01-27: [Business Login for Instagram](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login).
- Meta publishing docs reviewed for professional-account eligibility, app access levels, public media hosting, endpoints, and the 100-post/24-hour limit. These are recorded for later work only; M13 publishing remains out of scope: [Instagram content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing).

## Files changed
- `apps/api/package.json`
- `apps/api/src/app.module.ts`
- `apps/api/src/modules/social-accounts/social-accounts.controller.ts`
- `apps/api/src/modules/social-accounts/social-accounts.module.ts`
- `apps/api/src/modules/social-accounts/social-accounts.validation.ts`
- `apps/api/src/modules/social-accounts/social-accounts.validation.test.ts`
- `apps/api/src/modules/social-accounts/social-accounts.service.ts`
- `apps/api/src/modules/social-accounts/social-accounts.service.test.ts`
- `apps/api/src/modules/social-accounts/social-accounts.postgres.integration.test.ts`
- `apps/api/src/modules/social-accounts/token-vault.ts`
- `apps/api/src/modules/social-accounts/token-vault.test.ts`
- `packages/contracts/package.json`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/social-accounts.ts`
- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/20261110010000_m12_social_accounts_oauth/migration.sql`
- `packages/social-providers/package.json`
- `packages/social-providers/src/index.ts`
- `packages/social-providers/src/types.ts`
- `packages/social-providers/src/youtube.connector.ts`
- `packages/social-providers/src/youtube.connector.test.ts`
- `packages/social-providers/src/instagram.connector.ts`
- `pnpm-lock.yaml`
- This status file and `docs/WORK_LOG.md`

## Commands and evidence
All commands below used Node `24.22.2` and pnpm `12.16.1` where applicable. A dedicated disposable PostgreSQL 18.6 database on localhost port 55435 was used; no existing ReelForge or other project database was used.

- `pnpm install --frozen-lockfile` — **PASS**.
- `pnpm lint` — **PASS**.
- `pnpm format:check` — **PASS**.
- `DATABASE_URL=<disposable PostgreSQL URL on localhost:55435> pnpm typecheck` — **PASS** across all workspaces.
- `DATABASE_URL=<disposable PostgreSQL URL on localhost:55435> pnpm test` — **PASS**, 41 files passed / 1 skipped; 273 tests passed / 5 skipped. M12 reconnect and OAuth grant-cleanup regressions plus PostgreSQL persistence tests were included. The run emitted a non-fatal `pg` concurrent-query deprecation warning.
- `DATABASE_URL=<disposable PostgreSQL URL on localhost:55435> pnpm build` — **PASS** across all workspaces.
- `DATABASE_URL=<disposable PostgreSQL URL on localhost:55435> pnpm db:validate` — **PASS**.
- `DATABASE_URL=<fresh disposable PostgreSQL URL on localhost:55435> pnpm db:migrate:deploy` — **PASS**, all 19 migrations applied to a clean database; a subsequent deploy reported no pending migrations.
- `DATABASE_URL=<disposable PostgreSQL URL on localhost:55435> pnpm exec vitest run apps/api/src/modules/social-accounts/social-accounts.postgres.integration.test.ts` — **PASS**, 1 file / 2 tests, including cross-workspace foreign-key denial.
- `git diff --check` — **PASS**.
- Initial typecheck/schema-validation invocations without `DATABASE_URL` could not load the repository's Prisma config; reruns with the disposable URL passed. No database outside the disposable M12 container was contacted.

## Contract/schema authorization
- Minu provided written Core approval during this session for additive M12 Prisma schema/migration and contracts covering social accounts, OAuth state/tokens, permissions, and capabilities. This is not product approval.
- No previously applied migration was rewritten or reordered. No M00–M11 model was changed.

## Blockers, risks, and known gaps
- Minu's B1/B2 review blockers on PR #22 have been addressed in the current fix-forward: reconnect reuses the unique account row and rotates credentials/permissions/capabilities; P2002 is mapped to HTTP 409; failures after exchange best-effort revoke the newly issued grant, log revocation failure without token material, and preserve the original error.
- Instagram is deliberately `NOT_CONFIGURED`. Although current Meta documentation was verified, Unified Login's business-portfolio/app setup and the product's login/access-level choice require an explicit integration decision before a connector is implemented. No fake-success path or Meta API call exists.
- Production KMS, key delivery, and rotation remain open; the env key strategy is for local/development only.
- YouTube account connection requests `youtube.upload` to advertise future upload capability; M12 does not implement upload/session creation or publishing. Reviewer should confirm this scope is acceptable for the future M13 use case.
- Health checks do not upload. No live Google/Meta calls or real provider tokens were used in tests.
- No calendar, approval flow, analytics, dashboard, Prisma ESM fix, or M13 publishing was added.

## Next exact action
Push the B1/B2 fix-forward to PR #22 and request Minu's re-review. Stop for Minu; do not approve or merge.

## Reviewer decision
- Minu requested changes on PR #22; B1 and B2 are addressed locally and await re-review. No approval or merge is claimed.
