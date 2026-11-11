# M24 Status — Ideas, Scripts & Storyboard Workspace

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned engineer:** Developer `imTusharsingh`
- **Branch:** `work/m24-ideas-scripts-storyboard-ui`
- **Updated:** 2026-11-11
- **Reviewer:** independent Core review requested from `minu-the-reviewer`; no approval or merge claimed.

## Synchronization and scope

Verified prerequisite PR #53 merged into main at `f6405bac35b3a372c41cfe57d70eb253039aab87`. Reviewed and preserved existing exploratory model commit `c836bc9`; merged main into the existing branch in `9786cee`. No branch recreation, discarded exploratory work, force push, backend/schema/shared-contract/root dependency change or production service change.

Uses normal `/planning`, `/planning/ideas/[ideaId]` and `/planning/scripts/[scriptId]` pages with the existing `AuthWorkspace`, verified-role `WorkspaceProvider`, primitives, design tokens and shared navigation guard. Planning is added to both shell navigation variants; Overview, Channels and Operations remain functional. Authentication has no route-selection logic.

## Task coverage and estimate

All nine task surfaces implemented to the currently persisted backend boundary. Supported flows are ready for independent review; end-to-end new-script generation is blocked by the server's unconfigured provider, not claimed complete.

| Task | Implementation / explicit boundary |
| --- | --- |
| T01 | Persisted idea list/create/edit, search, server status/archive filters, archive/restore, valid lifecycle transitions, duplicate-match cues. AI discovery proposals disabled because IdeaModule binds NotConfiguredIdeaLlm. |
| T02 | Full brief fields, channel/series selection, sources/notes, duplicate links and immutable approval snapshot inspection. Historical approvals lock editing. |
| T03 | Existing-script manual editing uses real M07 revisions; generation checksum/config/prompt request adapter tested. Preparation selects matching persisted snapshots. Generation stays disabled: ScriptModule binds NotConfiguredScriptLlm, registry is empty and no safe readiness catalog exists. No manual new-script endpoint exists. |
| T04 | Genuine paginated persisted history; read-only inspection, provenance when present, explicit copy into a new draft; never reconstructed history. |
| T05 | Ordered visual direction/camera/timing storyboard cards with keyboard scene selection and detailed scene editor. No fabricated images/media. |
| T06 | Stable-ID reorder with explicit start-time reflow; editable start/duration and backend-compatible positive/finite/total-duration validation. Text edits do not reflow other scenes. |
| T07 | Workspace characters and their published versions can be pinned/removed and saved in scene characterRefs. Asset assignment is explicitly disabled: no scene asset field exists. Repeated version IDs across scenes are blocked to match the current backend validator limitation. |
| T08 | Targeted scene patches preserve unrelated scenes, IDs and metadata; whole-document revision payload follows M07; explicit three-way rebase rejects overlapping edits. |
| T09 | Shared route/history/workspace/logout guards; scope-keyed clients and cancellation; timestamp/preflight conflicts preserve drafts; refresh failures retain open edits; uncertain writes retain a per-workspace pending marker and block automatic replay until explicit reconciliation. No sensitive draft bodies or credentials stored. |

## Changed files

- `apps/web/app/planning/layout.tsx`, `page.tsx`, `ideas/[ideaId]/page.tsx`, `scripts/[scriptId]/page.tsx`.
- `apps/web/features/planning/model.ts`, `session.tsx`, `common.tsx`, `library.tsx`, `idea-form.tsx`, `idea-workspace.tsx`, `script-workspace.tsx`, `planning.module.css`, `model.test.ts`.
- `apps/web/features/planning/verification/{README.md,fixtures.ts,mounted-fixture.tsx,next-link.tsx,mounted-browser.mjs,persistence.mjs,live-browser.mjs}` (test only).
- `apps/web/components/app-shell.tsx`: narrow navigation/breadcrumb integration only.
- This STATUS and `docs/WORK_LOG.md`.

## Executed verification

Node 24.22.2, pnpm 12.16.1; actual disposable PostgreSQL, all 28 existing migrations deployed; no pending migration. No Redis or paid provider required.

| Command | Actual result |
| --- | --- |
| `pnpm db:generate` / `pnpm db:migrate:deploy` | PASS; generated client, 28 migrations, no pending migration. |
| `pnpm db:validate` / `MIGRATION_BASE_SHA=origin/main pnpm db:check-migrations` / `pnpm security:secrets` | PASS; schema valid, 28 ordered immutable migrations, 551 tracked files scanned. |
| `pnpm typecheck` | PASS across workspace packages/apps. |
| `pnpm lint` | PASS. |
| `pnpm format:check` | PASS. |
| `NODE_ENV=production pnpm build` | PASS, including all three planning routes. |
| `pnpm test` | PASS: 612 passed, 8 skipped; includes 21 M24 unit/API-adapter tests and existing real HTTP/PostgreSQL tests. |
| `M24_TEST_DATABASE_URL="$DATABASE_URL" node apps/web/features/planning/verification/persistence.mjs` | PASS: four real M06/M07 PostgreSQL persistence/security scenarios. |
| `PLAYWRIGHT_MODULE=/workspace/validation-reelforge/browser/node_modules/playwright ESBUILD_MODULE=/workspace/validation-reelforge/browser/node_modules/esbuild node apps/web/features/planning/verification/mounted-browser.mjs` | PASS: 13 mounted Chromium scenarios; 390/768/1440px screenshots, no page errors. |
| `M24_TEST_DATABASE_URL="$DATABASE_URL" PLAYWRIGHT_MODULE=/workspace/validation-reelforge/browser/node_modules/playwright node apps/web/features/planning/verification/live-browser.mjs` | PASS: six actual Next/API/PostgreSQL browser scenarios, including genuine HTTP 409 compare/resubmit, persistence after reload, Viewer/tenant enforcement, mobile and existing navigation. |

Reproduction instructions and fixture boundaries: `apps/web/features/planning/verification/README.md`. Screenshots are local `/tmp/m24-{storyboard-*,live-desktop,live-mobile}.png`, not shipped application data.

Observed/fixed validation failures: initial unqualified build inherited development NODE_ENV and failed prerendering; explicit production build passes. A lint run overlapped Prisma regeneration and hit a transient generated-file ENOENT; rerun after generation passes. Early test-harness response reuse, locator, import-path and nested fixture errors were corrected before final results. No failed command is represented as a pass.

## Core contract proposals and remaining limits

1. **Atomic script concurrency (required Core follow-up):** M07 revision and approval endpoints do not accept the client's expected revision. The UI fetches and compares before sending and handles backend CAS 409s, but a write between preflight and POST can still overwrite a more recent document or approve an unseen revision. Idea status transitions similarly have no client timestamp token. Request atomic `expectedRevision`/expected status token semantics in a separate approved backend change. Do not treat frontend preflight as complete concurrency protection.
2. **Provider readiness:** register/configure actual idea/script adapters, provide a safe non-dispatching readiness contract and verify snapshot/budget policies before enabling generation. No real AI calls were made. New-script creation is unavailable until that dependency exists.
3. **Scene assets:** add an approved persisted scene asset contract before enabling assignment. No asset references are invented.
4. **Character references:** backend currently compares unique published-version count with flat reference count, rejecting repeated pins across scenes; separate Core fix needed before allowing repeated references.
5. Pending markers survive same-tab reload in sessionStorage; in-memory fallback blocks same-page retries when storage is unavailable. Unsaved draft bodies are intentionally not persisted to browser storage; browser unload confirmation protects them, and accepting discard abandons the draft.
6. Actual role changes are enforced by the server; 401/403 suspends UI writes until reauthentication. Full screen-reader, other browser engines and exhaustive accessibility/security review are not claimed.

## Review requirements / next action

Independent Core review must assess boundaries, concurrency limitations, permission/tenant enforcement, request shapes and real persistence, responsive/keyboard behavior, unsupported capability copy and exact-head CI. Resolve required findings on this branch. Do not self-approve or merge. Provider/atomic-concurrency blockers must be resolved separately before claiming the entire idea-to-new-script acceptance flow is production ready.
