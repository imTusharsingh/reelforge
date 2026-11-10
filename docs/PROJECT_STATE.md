# Project State - Single Handover Snapshot

**Project:** AI Shorts Channel Controller  
**State version:** 1.0  
**Last updated:** 2026-11-10
**Maintained by:** Core Architect/Reviewer

> This is the canonical handover summary for a new AI session. Update it after every approved integration or material decision. The detailed event history is in `WORK_LOG.md`; per-module detail is in each `STATUS.md`.

## Current project status

- **Overall phase:** Phase 1 in progress (M00–M16 integrated).
- **Current release:** v1.
- **Current integrated commit:** `602183aeed1f2fe9fa086cf819f86fc7de07bb72` (`origin/main` after M16 PR #29).
- **Active implementation sessions:** none.
- **Active work packages:** none; M17 and M18 are next and run in parallel worktrees after this docs-only closeout merges.
- **Blocked work packages:** none recorded.
- **Latest core review:** Minu requested changes on M16 PR #29 at `0c6b941c5f53e07885f327280ac2ff4970d381fb` (review `5838818072`, B1–B6), then approved at `1fbe818174ebdfd87218ca5d68e3ad5f6ff17e5c` (review `5839211545`) after the fix-forward commits; squash-merged by `minu-the-reviewer` at `602183aeed1f2fe9fa086cf819f86fc7de07bb72`.

## Frozen architecture summary

- Next.js + TypeScript web app.
- NestJS modular monolith API plus separate worker process.
- pnpm monorepo; PostgreSQL + Prisma; Redis + BullMQ; S3-compatible storage; FFmpeg.
- Multi-tenant workspace boundary; multiple channels per workspace.
- YouTube first, Instagram next; TikTok/Facebook Reels deferred.
- Manual approval default; configurable auto-publish only behind hard gates.
- Deterministic workflow state machines; provider-neutral adapters.
- No live provider calls in startup/seed/migration/health check/CI/tests.

## Current milestone

**Phase 1 in progress - M00–M16 integrated**

Next exact action:
1. Complete and submit this docs-only M16 integrated closeout PR for Minu's review; do not approve or merge.
2. After this closeout merges, implement M17 and M18 in parallel worktrees from the new `origin/main` tip (M17 migration `20261116010000`, M18 migration `20261117010000`; M17 merges first, then M18 rebases).

## Module status index

| Module | State | Branch | Approved commit | Blocker |
|---|---|---|---|---|
| M00 - Repository Governance & Shared Contracts | INTEGRATED | `main` (PR #2) | `626187aae7ffb6f8eba0bdbcff237f191ad0b904` | none |
| M01 - Identity & Workspace | INTEGRATED | `main` (PR #4) | `519b3ab2bd6a81a516c66d21036051edb9c54894` | none |
| M02 - Channel & Brand Management | INTEGRATED | `main` (PR #6) | `a9bb14b4b2519f5b66781f0cd8c00b955c38f983` | none |
| M03 - Genres, Formats & Content Series | INTEGRATED | `main` (PR #8) | `51fedc64fc655650ca345030d62934f8b16be1bc` | none |
| M04 - Characters & Asset Library | INTEGRATED | `main` (PR #10) | `110fbc0f0f4925f062815dbca68b6b9d666abd33` | none |
| M05 - Configuration & Prompt Engine | INTEGRATED | `main` (PR #12) | `055e11fab7d5dc058903766256c5b6c0de861e73` | none |
| M06 - Idea & Topic Registry | INTEGRATED | `main` (PR #15) | `ed52885c2341a0c676e251f9beef54f6d77661cd` | none |
| M07 - Script & Storyboard | INTEGRATED | `main` (PR #16) | `e1f20d34e13f3f9d00cc6d43f8c9e046f8af2896` | none |
| M08 - AI Provider Registry & Cost Ledger | INTEGRATED | `main` (PR #16) | `e1f20d34e13f3f9d00cc6d43f8c9e046f8af2896` | none |
| M09 - Scene Media Generation | INTEGRATED | `main` (PR #17) | `589d28c86feaede46f516bf27555f02802882610` | none |
| M10 - Video Composition & Export | INTEGRATED | `main` (PR #18) | `2c6fcbb4cb056bd1d9fa4bd42790d59c38217e5a` | Operational note below; no product blocker |
| M11 - Quality Assurance & Approval | INTEGRATED | `main` (PR #20) | `e61af2b92dd553faf96bb96850dcf37864a57a40` | Residual notes below; no product blocker |
| M12 - Social Accounts & Platform Adapters | INTEGRATED | `main` (PR #22) | `61e4d2f51712be387785464648bd4cf1fb6ca9c4` | residual notes below |
| M13 - Publishing Calendar & Delivery | INTEGRATED | `main` (PR #24) | `efa787aa11e00d09e8c1ec133f9217dc58cf270c` | residual notes below; no product blocker |
| M14 - Analytics Collection & Metric Store | INTEGRATED | `main` (PR #25) | `75b860375068150416a37482abc40223dfebcd4e` | residual notes below; no product blocker |
| M15 - Performance Intelligence & Learning | INTEGRATED | `main` (PR #27) | `9f5cdbac0b9bf87bfabf3488f0ce6bfe00f779d0` | residual notes below; no product blocker |
| M16 - Workflow Orchestration & Scheduler | INTEGRATED | `main` (PR #29) | `1fbe818174ebdfd87218ca5d68e3ad5f6ff17e5c` | residual notes below; no product blocker |
| M17 - Notifications & Reporting | NOT_STARTED | none | none | next after this closeout (parallel with M18) |
| M18 - Usage, Budget & Billing Foundation | NOT_STARTED | none | none | next after this closeout (parallel with M17) |
| M19 - Admin, Security, Audit & Observability | NOT_STARTED | none | none | none recorded |
| M20 - Core Integration & Release Gate | NOT_STARTED | none | none | none recorded |

M07/M08 integrated at PR #16. M09 is integrated at PR #17. M10 is integrated at PR #18 and its docs-only closeout is PR #19. M12 is integrated at PR #22. M13 is integrated at PR #24, M14 at PR #25, M15 at PR #27, and M16 at PR #29. M17–M20 remain `NOT_STARTED`.


## Open decisions

See `DECISION_LOG.md`. Pending provider vendor/model, email sender, hosting/KMS, and data-retention choices must be resolved before their affected production blocks are approved.

## Last integrated changes

- 2026-11-05: Initial project pack and v1 baseline created.
- 2026-11-05: M00 integrated by the owner via PR #2 at merge commit `8fdcab55bd121a695c76108f59dc3377a4c50940`, from Minu-approved head `626187aae7ffb6f8eba0bdbcff237f191ad0b904`.
- 2026-11-05/06: M01 integrated via PR #4. Minu approved head `519b3ab2bd6a81a516c66d21036051edb9c54894` (review 5789945311); owner merge `4944f5d74200c65cbcca99405cf680245946201a`.
- 2026-11-05/06: M02 integrated via PR #6. Minu approved head `a9bb14b4b2519f5b66781f0cd8c00b955c38f983` (review 5790491616); owner merge `216de538c86915f6f590ba7401b7d4cfc4e8f05c`.
- 2026-11-06: M03 integrated via PR #8. Minu approved head `51fedc64fc655650ca345030d62934f8b16be1bc` (review 5790935899); owner merge `408bae0af76b9a901cbf4066dec2af2e0f6e2526`.
- 2026-11-06: M04 integrated via PR #10. Minu approved initial head `a7a1069fb8e8ff41575521dde126df4ad54936e6`, then approved merge head `110fbc0f0f4925f062815dbca68b6b9d666abd33`; merge `c0a408d9572011c3b0d66e6b6704d722477dc275` was performed by `minu-the-reviewer` after owner-authorized PM merge.
- 2026-11-06: M05 integrated via PR #12. Minu approved head `055e11fab7d5dc058903766256c5b6c0de861e73`; merge `618bd26f8d23dd4729032281dedca7bd085f9851` was performed by `minu-the-reviewer` after owner-authorized PM merge.
- 2026-11-06: M06 integrated via PR #15. Minu approved head `ed52885c2341a0c676e251f9beef54f6d77661cd`; merge `318d1f2dd7220233f9ca36a8b277a2257ebf8382` was performed by `minu-the-reviewer`.
- 2026-11-06: M07 and M08 integrated via PR #16. Minu approved head `e1f20d34e13f3f9d00cc6d43f8c9e046f8af2896`; squash merge `2d6d70379bf197d4db06c947077fa951b94d739f`.
- 2026-11-06: M09 integrated via PR #17. Minu technically approved head `99b1972191038f5e4f839892bbbb196e554d6215` with hosted run `42222606082`, job `127908073738`, green; official self-approval was unavailable because reviewer Minu authored PR #17. Minu performed the squash merge at `589d28c86feaede46f516bf27555f02802882610` (18:41 IST).
- 2026-11-09: M10 integrated via PR #18. Minu approved head `2c6fcbb4cb056bd1d9fa4bd42790d59c38217e5a` (review `5829841015`); Minu squash-merged at `7d00ced8be55bf9569fa699ff23a120a8a853bae` (22:54 IST).
- 2026-11-09: M10 status closeout documentation merged by Minu via PR #19 at `9935435aa03e959417b65ebeb7fac8da0e4aa87c`.
- 2026-11-10: M11 integrated via PR #20. Minu approved head `e61af2b92dd553faf96bb96850dcf37864a57a40` (review `5831183493`); Minu squash-merged at `42e33c5476ca2f392db199c2db70569c899213d8`.
- 2026-11-10: M12 integrated via PR #22. Minu approved implementation head `16a3f0a4d03b8fff13ac7f8932f8ada9a458db10` (review `5832180458`) and docs-only head `61e4d2f51712be387785464648bd4cf1fb6ca9c4` (review `5832197458`); Minu squash-merged at `a83132b9064a04e3b92266aa9ec4748551299062`.
- 2026-11-09: M13 integrated via PR #24. Minu approved head `efa787aa11e00d09e8c1ec133f9217dc58cf270c` (review `5833122821`, B1/B2 fix `18eebd8`); `minu-the-reviewer` squash-merged at `75eee789921948a1d19427c4b2994a88a8766bbe`.
- 2026-11-09: M14 integrated via PR #25. Minu approved head `75b860375068150416a37482abc40223dfebcd4e` (review `5833592187`, B1 fix `0bfc4c8`); `minu-the-reviewer` squash-merged at `02dbff53b794f2d78c58d6b44e08285e8c793ff1`.
- 2026-11-10: M15 integrated via PR #27. Minu requested changes at `f695bc6b658ddc90938fa96e3da9d8aeef8448b4` (review `5837610546`), the B1–B4 fixes landed in `896a370` and `9f5cdba`, and Minu approved head `9f5cdbac0b9bf87bfabf3488f0ce6bfe00f779d0` (review `5837873024`); `minu-the-reviewer` squash-merged at `0e4e01a0b7e0c27b583c697220330ddb8a2848ac`.
- 2026-11-10: M16 integrated via PR #29. Minu requested changes at `0c6b941c5f53e07885f327280ac2ff4970d381fb` (review `5838818072`, B1–B6), the fixes landed in fix-forward commits ending at `1fbe818174ebdfd87218ca5d68e3ad5f6ff17e5c`, and Minu approved head `1fbe818174ebdfd87218ca5d68e3ad5f6ff17e5c` (review `5839211545`); `minu-the-reviewer` squash-merged at `602183aeed1f2fe9fa086cf819f86fc7de07bb72`.

## Open engineering follow-ups

- **M11 residual notes (not product blockers):** No real AI quality adapter is configured; unconfigured evaluations enter manual review with an SQL `NULL` scorecard and cannot auto-approve. Disclosure flags are an ownership-derived stub and are not legally sufficient for M13. An `APPROVED` quality status can become stale after rights change; M13 must re-check gates at publish time. The regeneration cap holds only when script regeneration uses M07 `revise()` on the same script ID.

- **M12 residual notes (not product blockers):** Instagram remains fail-closed while the Unified Login/product integration decision is open. Production KMS, key delivery, and rotation remain open. On successful reconnect after `REAUTH_REQUIRED`, the old Google refresh grant is overwritten without best-effort revocation. YouTube `channels.list` uses a maximum of 50 results without pagination. The callback URL is normalized with `new URL(...).toString()`, which can differ from the exact Google-console redirect URI.

- **M13 residual notes (not product blockers):** A process crash between `startVideoUpload` returning and a successful session persist can still leave `UPLOADING` with no session URI; retry, reconcile, and a later `publishNow` all refuse (no automatic second insert). If all session-persist retries fail, the attempt becomes `FAILED_FINAL` and the in-memory YouTube session is orphaned until it expires. The no-progress branch in `transferUpload` can still return HTTP 200 with a non-published destination after marking reconciliation-required. `StoragePort.getObject()` still returns the full video as a `Buffer`; very large media may need a streaming boundary. Instagram publish stays fail-closed. Unconfigured M16 scheduling/M18 budget ports still fail closed. Production KMS delivery/rotation remains open.

- **M14 residual notes (not product blockers):** A crash or killed request after a job is marked `RUNNING` can still leave it stuck; an editor can create a new job. Large `video`+`day` reports are not paginated with `startIndex`/`maxResults`, so a truncated table is stored as unavailable days rather than detected as incomplete. The official authorization table still lists `yt-analytics.readonly`; re-check live queries if production collection is denied. `appendSnapshots` remains public because the PostgreSQL integration test uses it directly. Instagram collection stays fail-closed. Collection is editor-triggered; there is no scheduler.

- **M15 residual notes (not product blockers):** `PublishingService.listPublishedPostContexts` has a 500-ID cap, so a channel with more than 500 videos that have in-window metrics fails the report with HTTP 400; it must be chunked. Concurrent recommendation generation can still duplicate rows because there is no unique key on `reportId`+`rank`. `INSUFFICIENT` buckets still expose averages, so the UI must not present them as conclusions. Views per video-day favors young videos. The M08 cost-ledger envelope must be added before binding any real insight adapter. Use channel/date-scoped published-record reads instead of the current workspace-wide page-and-filter. `REJECTED`, `RUNNING`, and `EXPORTED` have no transitions.

- **M16 residual notes (not product blockers):** Add a per-claim token before raising worker concurrency above 1. A crash-retry of the script, QA, or analytics step can create a new record. A retry after a final QA or render failure re-reads the old reference. BullMQ job re-add is not atomic. Resume can reset a `RECONCILIATION_REQUIRED` step. Resume after M11 QA approval is manual. The scheduler only looks back 5 minutes and does not backfill. A schedule's timezone can override the channel's. Provider limits are per workspace, not global. The worker loads the full `AppModule`. M14 `RUNNING` collection jobs are not reclaimed. Scheduled runs stay blocked (`BUDGET_POLICY_UNAVAILABLE`) until M18 provides the real `BudgetPolicyPort` adapter.

- **M10 operational note (not a product blocker):** A pending-upload row can remain when its writer dies before reporting completion. Cleanup keeps the row discoverable and warns about it; its tenant-scoped `RESTRICT` relation prevents deleting the render job until the row is resolved manually. Deployment scheduling is still required to invoke the worker/retention pass. FFmpeg remains an explicit local/runner dependency for real-render tests.


- **Follow-up (post-M04) - Prisma Client / Nest ESM runtime:** Fix the post-build Node ESM runtime so `node dist/...` boots without manually patching compiled dist imports. Prisma-generated client output currently contains extensionless relative imports that plain Node ESM cannot resolve (observed on tip `c0a408d9572011c3b0d66e6b6704d722477dc275` with Node 24.22.2; `--experimental-specifier-resolution=node` did not resolve it). Prefer a durable fix on `main` (for example generator, `package.json` `"type"`, module-resolution, or build-emit strategy), chosen by the implementer of a later fix after reading the current `packages/database` and `apps/api` build. Track as open until a product PR lands; not part of this closeout PR and not fixed here.

## Live verification

- Minu ran a live M01–M04 end-to-end API smoke on tip `c0a408d9572011c3b0d66e6b6704d722477dc275`: health, auth, workspace, channel, genre/series, `starter-nova` publish, reference package, PNG upload, cross-workspace 404, and other-user 403. Result: **PASS**. Portable Postgres and local storage were used; Node required a local-only compiled-dist `.js` extension patch to boot, which is recorded above as an open follow-up and was not a product failure in the smoke.

## How a new session resumes

1. Read this file first.
2. Read the latest decisions in `DECISION_LOG.md`.
3. Read the append-only `WORK_LOG.md` entries after the last integrated commit.
4. Read the assigned module's `WORK_PACKAGE.md` and `STATUS.md`.
5. Inspect Git status and current source code before making edits.
6. Do not assume a previous session's claims are correct until verified in the repository.
