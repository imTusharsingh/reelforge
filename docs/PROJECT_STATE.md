# Project State - Single Handover Snapshot

**Project:** AI Shorts Channel Controller  
**State version:** 1.0  
**Last updated:** 2026-11-06
**Maintained by:** Core Architect/Reviewer

> This is the canonical handover summary for a new AI session. Update it after every approved integration or material decision. The detailed event history is in `WORK_LOG.md`; per-module detail is in each `STATUS.md`.

## Current project status

- **Overall phase:** Phase 1 in progress (M00–M05 integrated; M06 next).
- **Current release:** v1.
- **Current integrated commit:** `618bd26f8d23dd4729032281dedca7bd085f9851` (`git rev-parse origin/main`; M05 PR #12 merge).
- **Active implementation sessions:** none.
- **Active work packages:** none after M05 closeout; M06 is next after this closeout merges.
- **Blocked work packages:** none recorded.
- **Latest core review:** Minu approved M04 at `110fbc0f0f4925f062815dbca68b6b9d666abd33` (prior approval at `a7a1069fb8e8ff41575521dde126df4ad54936e6`); PR #10 merged at `c0a408d9572011c3b0d66e6b6704d722477dc275` by `minu-the-reviewer` after owner-authorized PM merge.

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

**Phase 1 in progress - M00–M05 integrated; M06 next**

Next exact action:
1. After this closeout is merged, start M06 (Idea & Topic Registry).
2. Do not start M06 implementation in this closeout.

## Module status index

| Module | State | Branch | Approved commit | Blocker |
|---|---|---|---|---|
| M00 - Repository Governance & Shared Contracts | INTEGRATED | `main` (PR #2) | `626187aae7ffb6f8eba0bdbcff237f191ad0b904` | none |
| M01 - Identity & Workspace | INTEGRATED | `main` (PR #4) | `519b3ab2bd6a81a516c66d21036051edb9c54894` | none |
| M02 - Channel & Brand Management | INTEGRATED | `main` (PR #6) | `a9bb14b4b2519f5b66781f0cd8c00b955c38f983` | none |
| M03 - Genres, Formats & Content Series | INTEGRATED | `main` (PR #8) | `51fedc64fc655650ca345030d62934f8b16be1bc` | none |
| M04 - Characters & Asset Library | INTEGRATED | `main` (PR #10) | `110fbc0f0f4925f062815dbca68b6b9d666abd33` | none |
| M05 - Configuration & Prompt Engine | INTEGRATED | `main` (PR #12) | `055e11fab7d5dc058903766256c5b6c0de861e73` | none |
| M06 - Idea & Topic Registry | NOT_STARTED | none | none | none recorded |
| M07 - Script & Storyboard | NOT_STARTED | none | none | none recorded |
| M08 - AI Provider Registry & Cost Ledger | NOT_STARTED | none | none | none recorded |
| M09 - Scene Media Generation | NOT_STARTED | none | none | none recorded |
| M10 - Video Composition & Export | NOT_STARTED | none | none | none recorded |
| M11 - Quality Assurance & Approval | NOT_STARTED | none | none | none recorded |
| M12 - Social Accounts & Platform Adapters | NOT_STARTED | none | none | none recorded |
| M13 - Publishing Calendar & Delivery | NOT_STARTED | none | none | none recorded |
| M14 - Analytics Collection & Metric Store | NOT_STARTED | none | none | none recorded |
| M15 - Performance Intelligence & Learning | NOT_STARTED | none | none | none recorded |
| M16 - Workflow Orchestration & Scheduler | NOT_STARTED | none | none | none recorded |
| M17 - Notifications & Reporting | NOT_STARTED | none | none | none recorded |
| M18 - Usage, Budget & Billing Foundation | NOT_STARTED | none | none | none recorded |
| M19 - Admin, Security, Audit & Observability | NOT_STARTED | none | none | none recorded |
| M20 - Core Integration & Release Gate | NOT_STARTED | none | none | none recorded |

M05–M20 remain `NOT_STARTED`. M05 starts only when Minu assigns it after this closeout is merged.


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

## Open engineering follow-ups

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
