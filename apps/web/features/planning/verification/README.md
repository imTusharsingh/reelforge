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

- Vitest: runtime/scoped DTO guards, actual API request shapes, timestamps, roles, cancellation, paging, duration validation, targeted scene preservation, reorder, explicit three-way conflict rebasing and pending-save replay prevention.
- Mounted Chromium: 13 scenarios covering ideas/search/filter requests, manual edits, persisted-response rebasing, storyboard selection/order/timing, published character pins, disabled assets, viewer restrictions, navigation confirmation, stale revisions, uncertain writes and failed-refresh draft retention; 390/768/1440px screenshots in `/tmp`.
- Real PostgreSQL: four M06/M07 service scenarios, including stale timestamp rejection, archive/restore, historical approval locks, scene revision persistence, true history, approval immutability and tenant/role rejection.
- Real Next/API/PostgreSQL Chromium: six scenarios covering create/edit/reload/archive/restore, actual HTTP 409 compare/resubmit, script save/reload/history, unchanged unrelated scene, approved/readiness locks, authenticated Viewer UI and HTTP write denial, cross-tenant denial, mobile overflow and existing navigation.

The mounted harness replaces only Next routing and HTTP with explicit test doubles. The live runner uses the actual production web build, API guards, services and migrated PostgreSQL. Neither result implies live AI-provider readiness. Full screen-reader and exhaustive browser-engine testing remain independent review work.
