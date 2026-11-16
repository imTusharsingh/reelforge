# V7 verification

Issue #112 (body and all three comments) is the locked specification and wins over #116.

The new flow uses V1 ChannelBrief, VideoRun, ProviderCapability and autonomyPolicy.
The primary screens are `/channels/:id`, `/onboarding`, `/settings` and
`/settings/providers`. Legacy configuration stays under `/channels/:id/advanced`
until T2. No genre selection is needed.

V2/V3 integration seams (replace the HTTP transport or route bindings when those
APIs merge; screen components use the same client):

- GET `/api/v1/workspaces/:id/provider-keys`: `{ gemini: boolean, xai: boolean }`.
- PUT `/api/v1/workspaces/:id/provider-keys/:provider`: write-only `{ key }`.
  V2 owns encryption. V7 never reads the response body or logs it.
- GET `/api/v1/workspaces/:id/providers/capabilities`: V1 ProviderCapability[].
- POST `/api/v1/runs`: workspace/channel, pinned Brief id/version, idempotency key;
  returns the V1 VideoRun. V3 owns persistence, execution and SSE.
- BriefApprovals is the conservative V3 approval-count stub (zero until wired).
  Only a channel's approved Shorts may unlock L3; published uploads and workspace
  totals must never substitute. Boundary tests supply 9 and 10 approvals.

Absent V2/V3 services show unavailability; production does not fabricate queues,
health results or encrypted storage. The explicit test transport in
`setup.fixture.ts` is not imported by runtime code. No tests call live providers.
The browser test uses real signup/workspace/Brief APIs and Postgres, intercepting
only V2/V3 HTTP responses. It runs axe at onboarding, Brief, keys and capabilities
on mobile and desktop. The existing E2E server fixture supplies offline adapters.

Run after generating Prisma, building contracts and deploying migrations to a
disposable Postgres, with Redis available:

```
pnpm exec playwright test --config apps/web/features/brief/verification/playwright.config.ts
```

Onboarding retains successful workspace/channel/Brief responses in memory and
reuses one run idempotency key on retry. A reload starts a new setup; durable
cross-reload reconciliation of an interrupted channel-create response is not
provided by the legacy channel API. V3 must honor the supplied idempotency key.
