# M28 mounted browser verification

Run `node apps/web/features/insights/verification/mounted-browser.mjs` with `PLAYWRIGHT_MODULE`, `ESBUILD_MODULE`, and `CHROMIUM_PATH` set when those tools are not globally resolvable. The script verifies the M28 views at 390px and 1440px, role controls, queue-and-run collection, top-content/video detail, and unavailable/partial/insufficient/AI states without live provider calls.
