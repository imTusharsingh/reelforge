# M23 mounted review regression checks

`mounted-browser.mjs` bundles the real feature components into a temporary local fixture page and runs Chromium. `mounted-fixture.tsx` and `fixtures.ts` are test-only; no application route imports them. Mock OWNER/EDITOR/VIEWER values test the component/request seams only. They do not authorize or prove real role-aware UI editing, which remains blocked by the Core contract.

The runner uses external Playwright/esbuild tooling without modifying repository dependencies or configuration. With those packages available outside the checkout:

```bash
PLAYWRIGHT_MODULE=/path/to/playwright \
ESBUILD_MODULE=/path/to/esbuild \
node apps/web/features/channels/verification/mounted-browser.mjs
```

The environment's `/usr/bin/chromium` is the default executable; set `CHROMIUM_PATH` to override it. The runner reports each actual result and exits nonzero on failure. It covers mounted mutations and invalidation, pristine/dirty server rebasing, structured fields, scoped pickers, snapshot/prompt active-state updates, desktop/mobile and keyboard intents, programmatic routing, history traversal, uncertain-save reconciliation and context/role changes. It never connects to real providers or uses real credentials.
