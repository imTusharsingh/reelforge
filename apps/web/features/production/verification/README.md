# M25 verification

These fixtures are isolated browser test doubles. Application code does not import them, and they never register or call a provider.

```bash
PLAYWRIGHT_MODULE=/path/to/playwright-core ESBUILD_MODULE=/path/to/esbuild \
  node apps/web/features/production/verification/mounted-browser.mjs
```

The mounted scenarios cover persisted scene sequence and narration, explicit provider unavailability, Viewer restrictions, disabled unsupported asset assignment, authorized media paths, media failure, and 390px/1440px overflow. Screenshots are written to `/tmp` and are not product fixtures.
