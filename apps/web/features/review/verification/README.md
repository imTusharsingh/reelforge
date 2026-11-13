# M26 mounted verification

All fixtures are test-only. The harness mounts the real Review components, client,
shared shell, tokens and controls with controlled API responses; Next's router is
replaced by the existing M24/M25 browser seam. No provider is registered or called.

```bash
PLAYWRIGHT_MODULE=/path/to/playwright-core ESBUILD_MODULE=/path/to/esbuild \
  node apps/web/features/review/verification/mounted-browser.mjs
```

Requires Chromium (`CHROMIUM_PATH`, default `/usr/bin/chromium`) and FFmpeg
(`FFMPEG_PATH`, default `/usr/bin/ffmpeg`). FFmpeg creates a one-second local video
in `work/`; no external assets are downloaded. Screenshots are written to
`work/m26-review-390.png` and `work/m26-review-1440.png`.

Scenarios cover queue scope/empty/error, unavailable and persisted AI evaluation,
Owner/Editor/Viewer permissions, missing/failed gate evidence, required reason,
regeneration route/scene/override, history and safe links (including the exact persisted
render route and successful-render retry limitation), status-specific wording for
missing AI scorecards, ambiguous success and
409 reconciliation without duplicate writes, automatic approval, authenticated
preview paths with valid/expired media, keyboard focus and responsive overflow.

Unit/API contract tests run with `pnpm exec vitest run apps/web/features/review`.
Database-backed quality authorization, supersession and publishing gate tests are
part of the existing repository `NODE_ENV=test pnpm test` suite. Browser fixtures
prove UI behavior, not live provider or deployed end-to-end connectivity.
