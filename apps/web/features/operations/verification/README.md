# Operations mounted verification

Mounts the actual operations screen with controlled API responses. No providers are called.

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core ESBUILD_MODULE=/path/to/esbuild \
  CHROMIUM_PATH=/path/to/chrome node apps/web/features/operations/verification/mounted-browser.mjs
```

Exercises owner, editor, and viewer at 390px and 1440px, including mutation visibility, read-only controls, and overflow.
