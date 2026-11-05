# Project State - Single Handover Snapshot

**Project:** AI Shorts Channel Controller  
**State version:** 1.0  
**Last updated:** 2026-11-05  
**Maintained by:** Core Architect/Reviewer

> This is the canonical handover summary for a new AI session. Update it after every approved integration or material decision. The detailed event history is in `WORK_LOG.md`; per-module detail is in each `STATUS.md`.

## Current project status

- **Overall phase:** Planning baseline created; implementation not started.
- **Current release:** v1.
- **Current integrated commit:** none.
- **Active implementation sessions:** none.
- **Active work packages:** none.
- **Blocked work packages:** none recorded.
- **Latest core review:** not started.

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

**Milestone 0 - Governance and repository foundation**

Next exact actions:
1. Create the actual Git repository using this pack.
2. Have the Core Architect session inspect the docs and create the `M00` repository foundation work branch.
3. Implement M00 and freeze the first shared contracts/schema.
4. Start independent module sessions only after M00 is approved.

## Module status index

| Module | State | Branch | Approved commit | Blocker |
|---|---|---|---|---|
| M00 - Repository Governance & Shared Contracts | NOT_STARTED | none | none | none recorded |
| M01 - Identity & Workspace | NOT_STARTED | none | none | none recorded |
| M02 - Channel & Brand Management | NOT_STARTED | none | none | none recorded |
| M03 - Genres, Formats & Content Series | NOT_STARTED | none | none | none recorded |
| M04 - Characters & Asset Library | NOT_STARTED | none | none | none recorded |
| M05 - Configuration & Prompt Engine | NOT_STARTED | none | none | none recorded |
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


## Open decisions

See `DECISION_LOG.md`. Pending provider vendor/model, email sender, hosting/KMS, and data-retention choices must be resolved before their affected production blocks are approved.

## Last integrated changes

- 2026-11-05: Initial project pack and v1 baseline created. No application implementation exists yet.

## How a new session resumes

1. Read this file first.
2. Read the latest decisions in `DECISION_LOG.md`.
3. Read the append-only `WORK_LOG.md` entries after the last integrated commit.
4. Read the assigned module's `WORK_PACKAGE.md` and `STATUS.md`.
5. Inspect Git status and current source code before making edits.
6. Do not assume a previous session's claims are correct until verified in the repository.
