# M06 Status - Idea & Topic Registry

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Module Implementation Agent
- **Branch/worktree:** `work/m06-idea-and-topic-registry`
- **Last updated:** 2026-11-06
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** none

## Current objective
Generate, track, approve, and de-duplicate content ideas.

## Task checklist
- [x] M06-T01: T01 Define idea/topic lifecycle and status transitions.
- [x] M06-T02: T02 Support user-entered ideas and AI-proposed ideas through typed LLM port.
- [x] M06-T03: T03 Store topic, hook, angle, target audience, references/source notes, and expected format.
- [x] M06-T04: T04 Implement exact/normalized title checks and text similarity checks for prior content.
- [x] M06-T05: T05 Implement approval/rejection/backlog and scheduled idea selection.
- [x] M06-T06: T06 Enforce cooldown and minimum diversity rules per channel/series.
- [x] M06-T07: T07 Persist model/prompt versions and cost for AI idea generation.


## Files changed
- `apps/api/src/modules/idea/**`: authenticated workspace-scoped registry API, validation, lifecycle, duplicate checks, diversity/cooldown rules, and tests.
- `apps/api/src/app.module.ts`, `apps/api/package.json`, `packages/ai-providers/src/index.ts`: module wiring and typed injectable LLM port.
- `packages/database/prisma/schema.prisma`, `packages/database/prisma/migrations/20261106140000_idea_topic_registry/migration.sql`, `pnpm-lock.yaml`: additive idea and duplicate persistence.

## Commands and evidence
- `pnpm install --frozen-lockfile` — **NOT PASSED**; Node `24.16.0` does not satisfy the repository pin `24.22.2`.
- `pnpm install --lockfile-only --config.engine-strict=false` — **PASSED**; lockfile current.
- `pnpm --config.engine-strict=false --filter @reelforge/ai-providers build` — **PASSED**.
- `DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/reelforge?schema=public' pnpm --config.engine-strict=false typecheck` — **PASSED** across workspaces.
- `pnpm --config.engine-strict=false exec vitest run apps/api/src/modules/idea` — **PASSED**, 1 file / 4 tests.
- `pnpm --config.engine-strict=false lint` — **PASSED**.
- `pnpm --config.engine-strict=false format:check` — **PASSED**.
- `DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/reelforge?schema=public' pnpm --config.engine-strict=false db:validate` — **PASSED**.
- `DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/reelforge?schema=public' pnpm --config.engine-strict=false test` — **PASSED**, 18 files / 95 tests.
- `DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/reelforge?schema=public' pnpm --config.engine-strict=false build` — **PASSED**.
- `DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/reelforge?schema=public' pnpm --config.engine-strict=false db:migrate:deploy` — **FAILED** with Prisma `P1000`; local PostgreSQL credentials were rejected. No migration deployment success is claimed.
- `git diff --check` — **PASSED**.

## Contract/schema proposals
- Additive `IdeaStatus`, `IdeaOrigin`, `Idea`, and `IdeaDuplicate` persistence is included in the M06 migration.
- Added the typed `IdeaProposalLlmPort` and `IDEA_PROPOSAL_LLM` token to the M08-owned provider stub. Runtime uses a fail-closed `NotConfigured` implementation; tests inject fixture doubles. No provider, source, or trend data is fabricated.

## Blockers / risks / unknowns
- Migration deployment needs rerun against a disposable PostgreSQL instance with valid credentials.
- Similarity uses deterministic normalized-title token Jaccard scoring; it flags candidates and never silently drops ideas.
- AI proposals require a real M08 adapter and return an explicit not-configured failure until then.
- Approved/scheduled idea fields are not exposed through an update route, preserving immutable content after approval; future script handoff should consume the persisted record/snapshot contract.

## Next exact action
Push this branch. Owner/PM opens `fix(m06): address post-merge Minu blockers`; do not merge or mark approved/integrated.

## Handoff notes
Implementation is complete pending Core Architect/Reviewer validation.

## Reviewer decision
- Pending.

## Fix-forward blockers
- B1: `@reelforge/ai-providers` now exposes source types for clean-checkout typecheck while retaining compiled runtime imports.
- B2: approval/scheduling creates an immutable workspace-scoped content snapshot with SHA-256 checksum and an approved read endpoint for M07 handoff.
- B3: AI proposals and provenance are runtime-validated; series-only input canonicalizes its channel and mismatches are rejected.
- B4: additive workspace-owned foreign keys cover channel, series, creator, matched idea, and approval snapshots; negative tests cover foreign references.
- B5: diversity uses a separate ten-item eligible queue window and requires two normalized topics after the three-item threshold; cooldown remains separate.

## Fix-forward verification
- Plain `pnpm install --frozen-lockfile` — **NOT PASSED**: Node `24.16.0` vs pinned `24.22.2`.
- Lint, format check, typecheck, full tests (18 files / 95 tests), build, schema validation, and `git diff --check` — **PASSED**.
- Migration deploy — **FAILED** with Prisma `P1000`; local PostgreSQL rejected supplied credentials.
- No approval, integration, merge, or PR creation is claimed.
