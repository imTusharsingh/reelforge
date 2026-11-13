# M22/C5 account verification

Mounted browser checks for the account/profile UI (profile save, password-change success/error states, and unavailable password reset on login) at 390px and 1440px.

Run with external Playwright and esbuild modules (no repo dependency changes):

```bash
PLAYWRIGHT_MODULE=/path/to/playwright-core ESBUILD_MODULE=/path/to/esbuild \
  CHROMIUM_PATH=/usr/bin/chromium \
  node apps/web/features/account/verification/mounted-browser.mjs
```

Fixtures mock `/api/v1` fetch responses only. No live provider, credential, or production data is used.
