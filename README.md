# ReelForge - AI Shorts Channel Controller
Repository name: reelforge. Product: ReelForge. The pack below is the planning baseline; Minu (project manager) acts as Core Architect/Reviewer.

This repository pack is the platform-independent source of truth for planning and coordinating multiple AI coding-editor sessions.

## Start here

1. Read `docs/PROJECT_CHARTER.md`.
2. Read `docs/ARCHITECTURE_BASELINE.md` and `docs/DECISION_LOG.md`.
3. Read `docs/AI_EDITOR_PROTOCOL.md` and `prompts/IMPLEMENTER_SESSION_PROMPT.md` before opening any implementation session.
4. Pick exactly one work package from `work-packages/` and assign it to one coding-agent session.
5. The Core Architect/Reviewer session reviews the work package, merges approved changes, and updates the central history.

## Source-of-truth order

When files disagree, use this precedence:

1. `docs/DECISION_LOG.md` - approved architectural/product decisions.
2. `docs/PROJECT_CHARTER.md` - frozen v1 scope and non-goals.
3. `docs/ARCHITECTURE_BASELINE.md` - system boundaries and technical baseline.
4. `docs/PIPELINES.md` - canonical workflow/state transitions.
5. `docs/MODULE_CATALOG.md` and the assigned `work-packages/Mxx/WORK_PACKAGE.md` - module scope and acceptance criteria.
6. `docs/PROJECT_STATE.md` - current progress snapshot.
7. `docs/WORK_LOG.md` - append-only event history.

A newer decision is not valid merely because a coding bot wrote it. It must be approved and recorded in `DECISION_LOG.md` by the Core Architect/Reviewer and project owner.

## The core operating rule

One implementation session owns one work package and one branch/worktree. It does not broaden scope, change shared contracts, or edit another module. The Core Architect/Reviewer is the only session that approves cross-module contracts and integrates work.

## Repository layout (target)

```text
apps/
  web/                         # Next.js user dashboard
  api/                         # NestJS HTTP API
  worker/                      # BullMQ workers and event handlers
packages/
  contracts/                   # Core-owned DTOs, events, ports, schemas
  database/                    # Core-owned Prisma schema and migrations
  config-engine/                # Configuration resolution and snapshots
  ai-providers/                 # Provider interfaces and approved adapters
  social-providers/             # Platform adapter interfaces and implementations
  media/                        # FFmpeg, media validation, storage abstractions
  observability/                # Logging, tracing, metrics conventions
  shared/                       # Shared utilities only; no domain dumping ground
prompts/
  IMPLEMENTER_SESSION_PROMPT.md
  CORE_REVIEWER_PROMPT.md
  CHANGE_REQUEST_PROMPT.md
work-packages/
  M00-.../WORK_PACKAGE.md
  M00-.../STATUS.md
  ...
docs/
  PROJECT_CHARTER.md
  ARCHITECTURE_BASELINE.md
  MODULE_CATALOG.md
  PIPELINES.md
  AI_EDITOR_PROTOCOL.md
  QUALITY_GATES.md
  PLATFORM_INTEGRATION_RULES.md
  DECISION_LOG.md
  CHANGE_CONTROL.md
  PROJECT_STATE.md
  WORK_LOG.md
```

## Status vocabulary

`NOT_STARTED` -> `READY` -> `IN_PROGRESS` -> `IMPLEMENTED_PENDING_REVIEW` -> `REVIEW_CHANGES_REQUESTED` or `APPROVED` -> `INTEGRATED`.

`BLOCKED` may be used from any non-terminal state, but the blocker and exact decision needed must be written down. `DONE` is not allowed until the Core Architect/Reviewer has approved the acceptance criteria and integration checks.
