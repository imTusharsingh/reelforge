# Platform and Provider Integration Rules

## 1. Official APIs only

Social publishing and analytics must use official APIs and authorized OAuth flows. Do not collect user passwords, automate a logged-in browser, bypass rate limits, or reverse engineer private endpoints.

## 2. Current-documentation verification

Before implementing or changing an integration, verify current official documentation for:

- supported account types and eligibility;
- app review, access level, and permission scopes;
- OAuth flow and refresh/revocation behavior;
- upload protocol, media requirements, and processing lifecycle;
- publish endpoint and idempotency/reconciliation options;
- rate limits, quotas, and errors;
- available analytics metrics, dimensions, delays, and reporting limits;
- required disclosures and platform policies.

Save the URL, access date, API version, relevant requirement, and affected code/interface in a platform capability note. Search snippets, forum answers, old SDK examples, or another vendor's wrapper are not enough to approve a capability.

## 3. Current v1 integration order

### YouTube first

- Upload through the official YouTube Data API video insertion method.
- Use OAuth with the minimum necessary upload scope.
- Support resumable upload/reconciliation where the official API supports it.
- Store the returned video ID and status.
- Use the YouTube Analytics API for authorized reporting; store only metrics supported for the account/query.

Official references to verify at implementation:
- https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol
- https://developers.google.com/youtube/analytics

### Instagram next

- Use the current official Meta Instagram Platform publishing documentation.
- Confirm the supported account types, login path, scopes, media requirements, container processing, publish request, and publishing limits for the chosen API version.
- Store API version and verification date in the connector docs.
- Do not infer eligibility or metrics from a third-party Postman collection.

Official reference to verify at implementation:
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing

TikTok and Facebook Reels are excluded from v1.

## 4. Provider adapter contract

Each provider adapter must expose:

- provider ID and version;
- explicit capabilities and limits;
- request schema validation;
- execution method;
- asynchronous job polling when required;
- normalized success result;
- normalized retryable/permanent error;
- usage/cost data or explicit unknown-cost result;
- request correlation ID;
- safe diagnostic metadata without secrets.

A provider that does not support reference images, specific dimensions, duration, or output type must fail preflight. Do not pretend it supports the capability.

## 5. No live calls by default

No provider calls during application start, seed, migration, unit/contract tests, CI, health checks, or ordinary dashboard browsing. An operator must explicitly trigger a live check after reading provider cost and risk details.

## 6. No fake integrations

A runtime adapter must make a real provider call or return a clear `NOT_CONFIGURED`, `CAPABILITY_UNSUPPORTED`, `AUTH_REQUIRED`, `QUOTA_EXCEEDED`, or provider-derived error. It must not return a fabricated asset, video ID, post ID, metric, or success response.
