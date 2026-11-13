# Offline browser journeys (#79)

Prerequisites: the repository's pinned Node/pnpm, Docker, FFmpeg/ffprobe on PATH,
and Chromium. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

For an installed system Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its
absolute path. `pnpm test:e2e --project=mobile-390` selects one viewport;
`--project=desktop-1440` selects the other. Ports 3300 and 3301 must be free.

The runner creates uniquely named, disposable PostgreSQL 18.6 and Redis 8.2.3
containers with dynamically assigned loopback ports. It generates Prisma, applies
the real migrations to its own empty database, and boots the real Nest API and
Next app. It does not use an existing DATABASE_URL or REDIS_URL. Containers and
local media are removed on completion. The database is seeded independently for
each viewport with password credentials, three workspace roles, an approved idea,
configuration/prompt snapshots, a licensed image, and a test social-account row.
Redis is exercised by the real API health/queue adapter.

The API fixture is outside the production source/build tree. Nest testing overrides
inject deterministic script/image providers and local filesystem storage. API
outbound HTTP throws, and the browser rejects external origins. There are no real
provider credentials, OAuth exchanges, uploads, external API calls, or mocked
browser API responses. FFmpeg performs the actual local composition; a test-only
poller claims queued renders and starts real quality review. The unconfigured AI
quality adapter requires human review through the UI. Publishing saves a real
draft and displays fail-closed preflight/calendar state; it never delivers it.

Both 390px and 1440px run the same ordered journey: sign-in; Owner/Editor/Viewer
workspace switching; channel creation and brand editing; script generation and
approval; scene generation and assignment of an existing asset; render creation;
quality approval; publishing composer and calendar; profile and password changes.
After every flow, axe runs with all default rules and fails on serious/critical
violations. Horizontal overflow and uncaught browser errors also fail. Full axe
JSON is attached for each flow. Failures retain screenshots and Playwright traces;
`pnpm exec playwright show-report` opens the HTML report.

`REELFORGE_API_ORIGIN` is the Next server-side API proxy destination, configured
when Next starts/builds. It defaults to `http://localhost:3001`. No repository
deployment configuration depends on the former misspelling, so no compatibility
alias is retained. The E2E web server sets the corrected variable to port 3301.

CI wiring is deliberately deferred to a dedicated chore PR: add a browser job
that installs Chromium/FFmpeg, runs `pnpm test:e2e` with Docker available, and
uploads `playwright-report/` and `test-results/` even on failure. This task does
not edit `ci.yml`.
