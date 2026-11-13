# M22/C5 account verification

Mounted browser checks for the account/profile UI (profile save, password-change success/error states, and unavailable password reset on login) at 390px and 1440px.

The CSRF smoke also runs `csrf-browser.mjs`; it verifies `/auth/csrf` before sign-in, a CSRF-attached authenticated profile mutation, and a cookie-authenticated mutation without the header returning `403 CSRF_TOKEN_INVALID`.

Run with external Playwright and esbuild modules (no repo dependency changes):

```bash
PLAYWRIGHT_MODULE=/path/to/playwright-core ESBUILD_MODULE=/path/to/esbuild \
  CHROMIUM_PATH=/usr/bin/chromium \
  node apps/web/features/account/verification/mounted-browser.mjs
```

Fixtures mock `/api/v1` fetch responses only. No live provider, credential, or production data is used.
