# M27 mounted verification

Run the offline Chromium harness with exact external tool pins; no repository dependency change is required:

```sh
M27_EVIDENCE_DIR=/workspace/work/m27-evidence \
PLAYWRIGHT_MODULE=/path/to/playwright-core \
ESBUILD_MODULE=/path/to/esbuild CHROMIUM_PATH=/usr/bin/chromium \
node apps/web/features/publishing/verification/mounted-browser.mjs
```

The harness covers persisted-response fixtures for composer, preflight, schedule/calendar, drafts, delivery history, retry/reconciliation, OAuth errors, verified roles, account controls, account recovery after reload and schedule edits. Responsive cases run at 390 and 1440 pixels. Authorization navigation is intercepted locally; there are no live provider calls. Screenshots are scratch evidence under M27_EVIDENCE_DIR (defaults to work/).

Backend tests include real disposable PostgreSQL HTTP replay and concurrent service insertion behavior, workspace isolation, eligible-render approval exclusions and migration uniqueness checks.
