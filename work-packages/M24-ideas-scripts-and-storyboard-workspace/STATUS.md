# M24 Status — Ideas, Scripts & Storyboard Workspace

- **State:** INTEGRATED (existing main merge via PR #55; documentation reconciliation only)
- **Assigned engineer:** Developer `imTusharsingh`
- **Branch / PR:** `work/m24-ideas-scripts-storyboard-ui` / [#55](https://github.com/imTusharsingh/reelforge/pull/55)
- **Last updated:** 2026-11-13
- **Reviewer:** `minu-the-reviewer`; independent review required. No self-approval or merge.

## Core #56 integration

Confirmed backend PR #57 is **MERGED**, merge commit `60df200b7cc307ffa9090d2663b6719de2a3dc5f`. Merged latest main into the existing M24 branch in `de25916`, without conflicts or discarded work. The earlier prerequisite PR #53 and all existing M24 work remain in history. No branch recreation or force push.

Read `docs/CORE_56_ATOMIC_PLANNING_CONTRACT.md`, controllers, validation and service implementations. No backend, schema, shared-contract or root tooling changes were made by M24; incoming Core changes are from the main merge. Core #56 requires no migration.

The old `atomicPlanningWritesAvailable` / `atomicPlanningWriteNotice` gate and associated disabled controls are removed. Controls are enabled through actual contract integration, not a boolean toggle:

- **Idea status:** PATCH includes `status`, `expectedStatus` and `expectedUpdatedAt` from the persisted idea the creator observed, plus future `scheduledAt` when scheduling. No fresh preflight token is substituted. Successful transitions refresh the canonical idea timestamp and approval snapshot. A 409 fetches current state and displays observed/latest comparison; another action remains blocked until explicit acceptance of the refreshed brief. No automatic retry.
- **Script revision:** POST sends `{expectedRevision: base.currentRevision, document: completeDraft}`. Validated targeted edits, ordering, timing and published character pins persist as a new server revision. Stale revision 409 preserves the local draft; comparison and conservative three-way rebase require explicit action and an explicit new save.
- **Script approval:** POST sends only the revision the creator reviewed: `{expectedRevision}`. Confirmation names the revision and explains immutability. Stale approval cannot approve an unseen revision. On success the client reads canonical approved state and the server export; export revision is validated and shown in a read-only inspector. Approved editors remain immutable across reload.

## Current task coverage

| Task | Implemented behavior / verified boundary |
| --- | --- |
| T01 | Persisted idea list/create/edit, search, status/archive filters, archive/restore, valid initial approval/scheduling/rejection/backlog transitions, duplicate-match cues. AI proposals remain unavailable. |
| T02 | Detailed brief, channel/series, sources/notes, immutable approval snapshot inspection; historically approved briefs cannot be edited or archived. |
| T03 | Existing-script manual editing and revision persistence **restored** using atomic caller tokens. New-script generation preparation consumes persisted snapshots, but generation remains disabled under unconfigured server adapters. |
| T04 | Genuine paginated persisted revision history; read-only inspection, available provenance and explicit copy into a new draft. |
| T05 | Ordered storyboard cards with timing/camera/visual direction, keyboard scene selection and a detailed scene editor. No fabricated images or media. |
| T06 | Stable-ID reorder, explicit reflow, start/duration editing and finite/positive/total-duration validation. Sequential storyboard policy starts at zero with no gaps/overlaps (1e-6 numeric tolerance); target duration allows one second. Order and timing **persist**. |
| T07 | Published workspace character versions can be pinned/removed and **persisted**. Scene asset assignment stays disabled because the schema has no asset field. Repeated version pins across scenes remain blocked to match the current backend validator. |
| T08 | Targeted scene patches preserve unrelated scenes, stable IDs and metadata; whole-document atomic revisions. Explicit rebase preserves disjoint concurrent scene changes and rejects overlapping changes. |
| T09 | Shared route/history/workspace/logout protections; scope-keyed clients and cancellation; preserved drafts on 409/read failures; uncached resource-specific interrupted-save reads, visible comparison and nonce-bound one-use acknowledgement. Failed/deferred/missing/foreign reads and active writes cannot unlock blind retries. No automatic replay or browser storage of draft bodies/credentials. |

Normal Next routes `/planning`, `/planning/ideas/[ideaId]`, `/planning/scripts/[scriptId]` retain the shared AuthWorkspace/verified WorkspaceProvider. Owner/Editor/Viewer roles, tenant scoping, design tokens/primitives and Overview/Channels/Operations navigation remain intact. No authentication route-selection logic was added.

## Files changed for Core integration

- `apps/web/features/planning/model.ts`: exact atomic request envelopes, observed tokens, canonical status refresh, approval/export validation; existing interrupted-save reconciliation retained.
- `idea-workspace.tsx`: restored lifecycle controls, explicit status conflict comparison, success/error states.
- `script-workspace.tsx`: restored save/approval controls, revision-specific confirmation, server export inspector and approved-state refresh protection.
- `idea-form.tsx`: clear an obsolete save error when the creator explicitly accepts the saved brief.
- `model.test.ts`: successful atomic writes, exact observed request tokens, stale/no-retry and Viewer regressions; existing recovery/timing tests retained.
- `verification/{mounted-fixture.tsx,mounted-browser.mjs,live-browser.mjs,persistence.mjs,README.md}`: updated real contracts and restored persistence/concurrency/export regressions.
- This STATUS and `docs/WORK_LOG.md`.

## Executed integration validation

Runtime: Node 24.22.2 / pnpm 12.16.1; local disposable PostgreSQL `reelforge_dev`. No paid AI/social calls, production service changes or new dependencies.

| Command | Actual result |
| --- | --- |
| `pnpm typecheck` | PASS across workspace packages/apps. |
| `pnpm lint` | PASS. |
| `pnpm format:check` | PASS. |
| `NODE_ENV=production pnpm build` | PASS across workspace, including planning routes. |
| `pnpm test` | PASS: **636 passed, 8 skipped**, including **41 M24 unit/adapter/recovery tests** and merged Core PostgreSQL interleaving regressions. |
| `PLAYWRIGHT_MODULE=/workspace/validation-reelforge/browser/node_modules/playwright ESBUILD_MODULE=/workspace/validation-reelforge/browser/node_modules/esbuild node apps/web/features/planning/verification/mounted-browser.mjs` | PASS: **17 mounted Chromium scenarios**, no page errors; 390/768/1440px screenshots. |
| `M24_TEST_DATABASE_URL="$DATABASE_URL" PLAYWRIGHT_MODULE=/workspace/validation-reelforge/browser/node_modules/playwright node apps/web/features/planning/verification/live-browser.mjs` | PASS: **11 actual Next/API/PostgreSQL scenarios**, no page errors. |
| `M24_TEST_DATABASE_URL="$DATABASE_URL" node apps/web/features/planning/verification/persistence.mjs` | PASS: **4 real PostgreSQL scenarios**, including concurrent writers and stale approval rejection with no unwanted revision/approval. |

Real-browser evidence covers actual idea CAS edit/status conflicts, stale expectedStatus and expectedUpdatedAt, lifecycle/approval snapshots, two authenticated Owner/Editor clients revising the same script, preserved 409 drafts, explicit rebase, persisted order/timing/character references, stale approval rejection, exact revision approval/export/history/reload, Viewer HTTP 403 and cross-tenant denial, mobile layout and existing navigation. It also commits a real idea update while dropping its response: a failed reconciliation read stays blocked, a successful read plus explicit comparison clears the marker, and no write is replayed.

The first character browser fixture lacked required persisted profile fields, causing a real API 500. The test fixture was corrected to the actual character profile contract; the rerun passed. No backend behavior was altered or failure reported as a pass.

Reproduction and test-only fixture boundaries: `apps/web/features/planning/verification/README.md`. Screenshots are local `/tmp/m24-{storyboard-*,live-desktop,live-mobile}.png`, not application data. Final formatting, secret scan and exact-head hosted CI are recorded in the PR after the final source push.

## Remaining unsupported functionality / limits

- **Providers:** IdeaModule and ScriptModule still bind unconfigured adapters and expose no safe general readiness catalog. AI proposals/new-script generation remain disabled. No manual new-script creation API exists; existing-script fixtures in tests are explicitly test-only. Core #56 integration does not claim provider availability or live paid verification.
- **Scene assets:** No persisted scene asset field; assignment remains disabled. Published character refs are supported, but the current backend rejects repeated character-version IDs across scenes.
- **Recovery:** Pending metadata survives same-tab reload via sessionStorage; an in-memory fallback protects same-page retries when browser storage is unavailable. Draft bodies are intentionally not stored; accepting navigation discard abandons unsaved work. For interrupted creates without a confirmed ID, recovery reads the unfiltered library for explicit user comparison.
- **Review:** Full screen-reader and other browser-engine coverage are not claimed. Independent Core review and exact-head CI remain required before integration. Existing snapshot immutability, genre/factuality policy and provider/budget checks remain server-owned.

## Review handoff

Core #56's atomic API prerequisite is consumed; the previous frontend release gate is superseded by the actual caller-token integration and real persistence/concurrency evidence. Review exact request shapes and caller-version provenance, no-retry behavior, 409 comparison/rebase, approved export binding, recovery, roles/tenant isolation and supported-vs-unavailable capability copy. Request independent review from `minu-the-reviewer`. Do not self-approve or merge.

## Main closeout — 2026-11-13 (#80)

- Existing integration: [PR #55](https://github.com/imTusharsingh/reelforge/pull/55), head `2ec7d434e82968a0ac22f922c34619192c5bc7c4`, merge `7a81e0710b4c1ff6ae1375aacb3ef6d89634db0e`. This records an existing merge; it grants no new review, approval, live-call or release authorization.
- Current scope/gaps: Core planning prerequisites #53/#57 are merged; C2 #95 enables script generation from approved ideas. Unconfigured real providers still fail closed.
- Earlier pending-review/next-action text above is historical evidence, superseded for merge state by this closeout. Earlier verification commands remain the original session's results; this documentation task does not rerun or upgrade them.
- Next action: keep release risks explicit, complete #78/#79 in their own assigned PRs, and submit this docs-only closeout for Minu review.
