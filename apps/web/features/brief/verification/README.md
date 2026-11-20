# V7 verification

Issue #112 (body and all three comments) is the locked specification and wins over #116.

The primary screens are `/channels/:id`, `/onboarding`, `/settings` and
`/settings/providers`.

- GET `/api/v1/workspaces/:id/providers/keys` returns the Gemini and xAI configuration flags.
- PUT `/api/v1/workspaces/:id/providers/:provider/key` accepts a key for encrypted storage.
- GET `/api/v1/workspaces/:id/providers/health` returns the persisted configuration and capability catalog.
- POST `/api/v1/runs` takes the workspace ID, immutable Brief ID and idempotency key. It returns the queued VideoRun ID.

The browser test uses real signup, workspace, Brief and run endpoints backed by
Postgres. It intercepts provider settings requests and checks accessibility on
mobile and desktop. No test calls a live provider.

Run after generating Prisma, building contracts and deploying migrations to a
disposable Postgres, with Redis available:

```
pnpm exec playwright test --config apps/web/features/brief/verification/playwright.config.ts
```

Onboarding retains successful workspace/channel/Brief responses in memory and
reuses one run idempotency key on retry. A reload starts a new setup; durable
cross-reload reconciliation of an interrupted channel-create response is not
part of the onboarding flow. VideoRun honors the supplied idempotency key.
