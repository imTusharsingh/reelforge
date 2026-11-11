# M24 verification

Application code never imports these fixtures or runners. No paid provider is registered or invoked. Browser tooling is supplied outside the repository to preserve root dependencies.

```bash
pnpm exec vitest run apps/web/features/planning/model.test.ts
NODE_ENV=production pnpm build
M24_TEST_DATABASE_URL="$DATABASE_URL" node apps/web/features/planning/verification/persistence.mjs
PLAYWRIGHT_MODULE=/path/to/playwright ESBUILD_MODULE=/path/to/esbuild node apps/web/features/planning/verification/mounted-browser.mjs
```

For actual Next/API integration, start the built API on port 3001 with the disposable database and `NODE_ENV=test` (HTTP development cookies), and the built web app on port 3000 with `NODE_ENV=production`. Then:

```bash
M24_TEST_DATABASE_URL="$DATABASE_URL" PLAYWRIGHT_MODULE=/path/to/playwright node apps/web/features/planning/verification/live-browser.mjs
```

`CHROMIUM_PATH` defaults to `/usr/bin/chromium`; `M24_TEST_WEB_ORIGIN` defaults to `http://127.0.0.1:3000`. Database runners explicitly accept only a localhost `reelforge_dev` disposable database. They add isolated UUID fixtures, including existing-script documents, memberships and temporary sessions. These are test fixtures, not a manual script-creation API or application seed. They do not delete historical records or alter production data. Sessions expire after one hour; use a disposable database.

Coverage:

- Vitest: runtime/scoped DTO guards, actual API request shapes, timestamps, roles, cancellation, paging, duration validation, targeted scene preservation, reorder, explicit three-way conflict rebasing, sequential timing, atomic observed-version writes, and successful resource-specific pending-save comparison with failure and in-flight protection.
- Mounted Chromium: 17 scenarios covering ideas/search/filter requests, manual idea edits, persisted-response rebasing, persisted storyboard selection/order/timing and published-character pins, disabled assets, viewer restrictions, navigation confirmation, stale revisions, uncertain writes and failed-refresh draft retention; 390/768/1440px screenshots in `/tmp`.
- Real PostgreSQL: four M06/M07 service scenarios, including stale timestamp rejection, archive/restore, historical approval locks, scene revision persistence, true history, approval immutability and tenant/role rejection.
- Real Next/API/PostgreSQL Chromium: 11 scenarios covering create/edit/reload/archive/restore, actual HTTP 409 compare/resubmit, atomic idea status lifecycle, two authenticated editors and explicit rebase, stale revision/approval rejection, correct approval/export/reload and immutable persisted documents, approved/readiness locks, authenticated Viewer UI and HTTP write denial, cross-tenant denial, mobile overflow and existing navigation.

Core #56 is integrated after merged PR #57: idea status changes send the observed expectedStatus/expectedUpdatedAt; script revisions send expectedRevision/document; approvals send the explicitly reviewed expectedRevision. No GET token is substituted before a write. Providers and scene asset assignment remain unavailable. Historical disabled-write tests are superseded by the current atomic persistence evidence.

The mounted harness replaces only Next routing and HTTP with explicit test doubles. The live runner uses the actual production web build, API guards, services and migrated PostgreSQL. It also drops a real committed PATCH response, verifies failed recovery reads stay blocked, then explicitly compares saved data before clearing the pending marker. The PostgreSQL service runner includes two competing revision writes from the same observed version (one winner), stale approval rejection and correct revision export. Neither result implies live AI-provider readiness. Full screen-reader and exhaustive browser-engine testing remain independent review work.
