# M22/C5 account verification

Mounted browser checks for the account/profile UI (profile save, password-change success/error states, and password recovery entry on login) at 390px and 1440px.

The separate `csrf-browser.mjs` smoke verifies `/auth/csrf` before sign-in, a CSRF-attached authenticated profile mutation, and a cookie-authenticated mutation without the header returning `403 CSRF_TOKEN_INVALID`.

Install the pinned browser and run both smokes from the repository root.

```bash
pnpm exec playwright install chromium
node apps/web/features/account/verification/mounted-browser.mjs
node apps/web/features/account/verification/csrf-browser.mjs
```

Set `CHROMIUM_PATH` only when using an existing compatible Chromium binary.
Both scripts use the workspace’s pinned Playwright and esbuild packages and local Next.js stubs.

Fixtures mock `/api/v1` fetch responses only. No live provider, credential, or production data is used.
