# M00 Status - Repository Governance & Shared Contracts

## Closeout chore scope (2026-11-05)

This branch closes M00 after owner merge of PR #2, records the approved dependency pins and owner-only merge process, adds a placeholder `.env.example`, and corrects Prettier's generated-client ignore path. The format check remained failing until the follow-up formatting fixes requested in PR #3 review. Product M00 is integrated; this closeout chore remains pending Minu review until its own PR is reviewed.

- **State:** INTEGRATED
- **Closeout chore PR #3:** IMPLEMENTED_PENDING_REVIEW
- **M00 product state:** INTEGRATED via PR #2; this closeout chore is pending its own review.
- **Assigned session/editor:** Codex implementation session
- **Branch/worktree:** `chore/m00-closeout` (based on integrated `main`)
- **Last updated:** 2026-11-05
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** `626187aae7ffb6f8eba0bdbcff237f191ad0b904` (Minu approval)
- **Integrated commit:** `8fdcab55bd121a695c76108f59dc3377a4c50940` (owner merge of PR #2)

## Current objective
Close the documentation and repository-hygiene items for already-integrated M00; no product implementation is in scope.

## Original M00 implementation session scope summary (2026-11-05)
- **Requested tasks:** M00-T01 through M00-T07: monorepo/tooling, minimal app/package bootstraps, shared contracts/events, Prisma baseline/migration policy, offline CI, governance templates/instructions, and contract versioning policy.
- **Dependencies:** None listed; M00 is the first block. No application code exists in the inspected planning pack.
- **Likely files:** Root workspace/tooling/CI configuration; `apps/{web,api,worker}/`; `packages/{contracts,database,config-engine,ai-providers,social-providers,media,observability,shared}/`; root contributor/editor instructions; this status file and `docs/WORK_LOG.md`.
- **Repository state:** Initial commit `773c1792dc9369172e8431944d979754dc9a1b30` from `main`; assigned branch `work/m00-monorepo-foundation`.
- **Ownership:** Resolved by Core Reviewer; this M00 session is authorized to edit its shared files.
- **Unknowns at original implementation handoff:** PR #2 review and merge were pending at that time; see the later dated integration record below.

## Task checklist
- [x] M00-T01: Initialize pnpm monorepo, strict TypeScript, formatting, lint, test framework, and build scripts.
- [x] M00-T02: Create apps/web, apps/api, apps/worker and shared packages with minimal bootstraps.
- [x] M00-T03: Define shared error envelope, pagination, correlation IDs, API versioning, and event envelope.
- [x] M00-T04: Define central Prisma schema baseline and migration policy for the frozen v1 domains.
- [x] M00-T05: Configure CI for install, lint, typecheck, unit tests, build, and migration validation without live external calls.
- [x] M00-T06: Add root AI editor instructions, work-package templates, contribution rules, and source-of-truth files.
- [x] M00-T07: Create typed event registry and contract versioning policy.


## Files changed
- Root: `.gitignore`, `.node-version`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `vitest.config.ts`, `AGENTS.md`, `CONTRIBUTING.md`, `README.md`.
- CI/templates: `.github/workflows/ci.yml`, `templates/WORK_PACKAGE_TEMPLATE.md`, `templates/STATUS_TEMPLATE.md`.
- Apps: `apps/web/**`, `apps/api/**`, `apps/worker/**`.
- Packages: `packages/{contracts,database,config-engine,ai-providers,social-providers,media,observability,shared}/**`, including the new `PublishStatus` and `WorkflowState` contracts and review migration.
- Docs/handoff: `docs/CONTRACT_VERSIONING.md`, `docs/WORK_LOG.md`, this M00 `STATUS.md`.

## Proposed pinned versions (for reviewer approval)

Verified 2026-11-05 from project release pages and npm package listings. All manifest declarations are exact versions; the Prisma ORM proposal uses stable v7.10.1 rather than the v8 release-candidate tag.

| Component | Proposed version | Verification source |
|---|---:|---|
| Node.js (LTS) | 24.22.2 | [Node.js downloads](https://nodejs.org/en/download), [Prisma ORM v7 system requirements](https://www.prisma.io/docs/orm/v7/reference/system-requirements) |
| pnpm (latest stable tag) | 12.16.1 | [pnpm npm versions](https://www.npmjs.com/package/pnpm?activeTab=versions) |
| Next.js | 16.4.5 | [Next.js npm versions](https://www.npmjs.com/package/next?activeTab=versions) |
| React / React DOM | 19.3.1 | [React npm versions](https://www.npmjs.com/package/react?activeTab=versions) |
| NestJS common/core/platform-express | 12.3.3 | [NestJS platform-express npm](https://www.npmjs.com/package/@nestjs/platform-express) |
| Express / express types | 5.3.0 / 5.0.6 | [Express npm](https://www.npmjs.com/package/express), [@types/express npm](https://www.npmjs.com/package/@types/express?activeTab=versions) |
| BullMQ | 6.6.0 | [BullMQ npm versions](https://www.npmjs.com/package/bullmq?activeTab=versions) |
| Prisma CLI / Client / PostgreSQL adapter | 7.10.1 | [Prisma Client npm](https://www.npmjs.com/package/@prisma/client?activeTab=versions), [Prisma ORM v7 docs](https://www.prisma.io/docs/orm/v7) |
| node-postgres | 8.23.1 | [pg npm versions](https://www.npmjs.com/package/pg?activeTab=versions) |
| Zod | 4.6.7 | [Zod npm versions](https://www.npmjs.com/package/zod?activeTab=versions) |
| TypeScript | 6.0.3 | [TypeScript 6.0 release](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/), [typescript-eslint supported version range](https://typescript-eslint.io/users/dependency-versions/) |
| Vitest | 5.1.0 | [Vitest npm](https://www.npmjs.com/package/vitest) |
| ESLint / typescript-eslint | 10.14.0 / 8.72.1 | [ESLint npm](https://www.npmjs.com/package/eslint), [typescript-eslint npm](https://www.npmjs.com/package/typescript-eslint?activeTab=versions) |
| Prettier | 3.9.10 | [Prettier npm versions](https://www.npmjs.com/package/prettier?activeTab=versions) |
| Type declarations (Node / React / React DOM) | 24.19.2 / 19.3.0 / 19.3.0 | [@types/node npm versions](https://www.npmjs.com/package/@types/node?activeTab=versions), [@types/react npm](https://www.npmjs.com/package/@types/react), [@types/react-dom npm](https://www.npmjs.com/package/@types/react-dom?activeTab=versions) |
| reflect-metadata / RxJS | 0.2.2 / 7.8.2 | [reflect-metadata npm](https://www.npmjs.com/package/reflect-metadata), [RxJS npm](https://www.npmjs.com/package/rxjs) |
| PostgreSQL CI service | 18.6 | [PostgreSQL 18.6 release notes](https://www.postgresql.org/docs/release/18.6/) |

## Commands and evidence
- `pnpm install --frozen-lockfile` (Node 24.22.2, pnpm 12.16.1): **passed**; lockfile up to date, all 12 workspace projects installed. A later sandboxed repeat failed to open the pnpm store lock because the filesystem is read-only; no dependency changes were made.
- `pnpm lint`: **passed**.
- `pnpm typecheck`: **passed** across all 12 workspace projects; Prisma client generation 7.10.1 completed.
- `pnpm test`: **passed**, 2 test files / 4 tests.
- `pnpm build` with `NEXT_TELEMETRY_DISABLED=1`, Node 24.22.2, pnpm 12.16.1, and `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/reelforge?schema=public`: **passed** for all workspaces. Sandbox execution of Next build failed to parse TypeScript `--showConfig`; elevated execution passed.
- `pnpm db:validate` with local placeholder `DATABASE_URL`: **passed**, schema valid.
- `pnpm db:migrate:deploy` against ephemeral `postgres:18.6-alpine` bound to 127.0.0.1:55432: **passed**, migration `20261105000000_foundation_baseline` applied. Container stopped after validation.
- `git diff --check`: **passed** before final documentation update; rerun before commit.
- GitHub Actions workflow itself: **not run locally**; configured to execute these checks and a Postgres service on GitHub Actions.

## Core review changes (PR #2)

Core Reviewer required changes 1–5 were implemented on `work/m00-monorepo-foundation` in review-fix commit `366980256610cb320ed21af822c10139f062dea1`:

1. Added Zod publish/workflow state enums and matching Prisma enums; `Video.status` remains a string with an M10 ownership TODO.
2. Added OutboxEvent channel, causation, and aggregate identity columns in new migration `20261105120000_review_publish_states_and_outbox_envelope`; the original baseline migration is unchanged. Known publish events backfill aggregate identity from `payload.postId`; unrecognized or incomplete rows stop the migration rather than receiving fabricated values.
3. Added per-event schema, producer, consumers, bounded retry and dead-letter policy; `parseRegisteredEvent` resolves the registry by event type and version. Added an unregistered-version test.
4. This status and the work log now reference PR #2 and the review-fix commit.
5. Worker startup logs that no handlers are registered and exits successfully without adding a handler.

## Review verification (2026-11-05)
- `pnpm install --frozen-lockfile` (Node 24.22.2 / pnpm 12.16.1): **passed**, 12 workspace projects, lockfile current.
- `pnpm lint`: **passed**. The first run caught an unused schema variable; it was corrected before this passing run.
- `pnpm typecheck` with local placeholder `DATABASE_URL`: **passed** across all 12 workspace projects; Prisma Client 7.10.1 generated.
- `pnpm test`: **passed**, 3 files / 9 tests.
- `pnpm build` with local placeholder `DATABASE_URL` and `NEXT_TELEMETRY_DISABLED=1`: **passed** for all workspace packages, executed outside the sandbox for Next.js process spawning.
- `pnpm db:validate`: **passed**, schema valid.
- `pnpm db:migrate:deploy`: **passed** against an ephemeral Postgres 18.6 container; baseline and new review migration both applied.
- `pnpm --filter @reelforge/database exec prisma migrate status`: **passed**, database schema up to date.
- Temporary database inspection verified exact enum values and required aggregate columns; worker `pnpm --filter @reelforge/worker start` **passed**, logging zero handlers and exiting cleanly.
- `git diff --exit-code 734c345 -- packages/database/prisma/migrations/20261105000000_foundation_baseline/migration.sql`: **passed**, confirming the original migration was not modified. `git diff --check`: **passed**.
- Populated legacy-row migration probe: **not run**; automatic approval review timed out on the optional fixture command. The migration was applied successfully to a fresh disposable database; its known-event backfill path remains unexercised locally.
- CI itself was not run locally.

## Contract/schema proposals
- For Core review: first versioned event payloads (`PostPublished`, `PublishFailed`), API error/pagination schemas, and the foundation Prisma table set described below. All use the frozen workspace tenant boundary and event-envelope fields from the canonical pipeline.
- Foundation Prisma models: `User`, `Workspace`, `WorkspaceMembership`, `Channel`, `ContentSeries`, `Asset`, `Video`, `Post`, `WorkflowRun`, and `OutboxEvent`. These are intentionally baseline records; module-specific states/configuration remain out of this schema.

## Blockers / risks / unknowns
- The sandbox blocks Next.js spawning TypeScript for `--showConfig`; the full build passed outside the sandbox. A sandboxed frozen-lockfile reinstall also hit a read-only store lock, while the initial install passed with registry access.
- Initial lockfile resolution exposed incompatible TypeScript 7.0.2; the pin was corrected to 6.0.3, within typescript-eslint's documented peer range `>=4.8.4 <6.1.0`. Full install then reported a blocked `msgpackr-extract` build script; its approval is now explicit in pnpm config. Prisma v7's documented Node range excludes Node 26, so Node was pinned to compatible LTS 24.22.2.

## Closeout chore scope summary (2026-11-05)
- **Requested tasks:** Record the verified M00 PR #2 integration in project state and status, append the closeout work log and ADRs, add a placeholder-only `.env.example`, correct Prettier ignores, and enable `format:check` in CI only if it passes locally.
- **Dependencies:** Owner-merged M00 PR #2 on `main`; no product module changes.
- **Branch/base:** `chore/m00-closeout` from `main` at `8fdcab55bd121a695c76108f59dc3377a4c50940`.
- **Initial environment note:** Node.js/pnpm/Corepack and `gh` were absent from the default PATH when this closeout branch was prepared. Node 24.22.2 and pnpm 12.16.1 have since been provisioned in temporary paths for review verification; `gh` remains unavailable.

## Next exact action
Address Minu's PR #3 review, push the updated `chore/m00-closeout` branch, and request re-review. Only the owner merges after Minu's written approval. After closeout, Phase 1 starts with M01 per Minu's plan.

## Handoff notes
Product M00 is integrated by the owner through PR #2. This branch contains only the closeout and hygiene scope; the closeout chore PR awaits Minu's review.

## Reviewer decision
- Product M00: **APPROVED** by Minu at `626187aae7ffb6f8eba0bdbcff237f191ad0b904`; **INTEGRATED** by owner via PR #2 at `8fdcab55bd121a695c76108f59dc3377a4c50940`.
- Closeout chore PR: **IMPLEMENTED_PENDING_REVIEW**; no approval is claimed.

## CI follow-up (2026-11-05)
- Updated the workflow runner to `ubuntu-24.04` and GitHub Actions to `actions/checkout@v7`, `pnpm/action-setup@v6`, and `actions/setup-node@v7` to remove the Node 20 deprecation warning and future runner migration notice. Versions were checked against their official release pages before the workflow change.
- Local `pnpm exec prettier --check .github/workflows/ci.yml` and `git diff --check`: **passed** before commit `b944dd6bb168ac261534a0baf460078d85f897b2`.
- GitHub Actions push run [42022606398](https://github.com/imTusharsingh/reelforge/actions/runs/42022606398): **passed** on `b944dd6`; quality job completed in 1m 32s, 3 test files / 9 tests.
- GitHub Actions pull request run [42022612235](https://github.com/imTusharsingh/reelforge/actions/runs/42022612235): **passed** on `b944dd6`; quality job completed in 1m 21s, 3 test files / 9 tests.
- No provider credentials or external provider calls were used. PR #2 remains open and unmerged.

## M00 closeout chore evidence (2026-11-05)
- Product M00 approval: Minu approved at `626187aae7ffb6f8eba0bdbcff237f191ad0b904`.
- Product M00 integration: owner merged PR #2 to `main`; verified merge commit `8fdcab55bd121a695c76108f59dc3377a4c50940`.
- This branch's work: project state/status closeout, append-only ADR-012 and ADR-013, local-only `.env.example`, and Prettier ignore correction. Product M00 state is `INTEGRATED`; chore PR #3 remains `IMPLEMENTED_PENDING_REVIEW` pending Minu's review.
- `git diff --check`: **passed**.
- `git check-ignore .env`: **passed**; `.env` is ignored. `.env.example` is explicitly allowed by the existing `!.env.example` rule.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm format:check`: **not run successfully**; each command exited 127 because `pnpm` is not installed or available in PATH. Node.js is also unavailable. CI remains unchanged because local `pnpm format:check` did not pass.
- Generated Prisma client files under `packages/database/src/generated` were present as untracked workspace files before this branch and were left untouched.
- No schema, migration, product code, or shared contract changes were made.
- Branch push: `git push -u origin chore/m00-closeout` **passed**; branch is published at the current head.
- PR creation: **not completed**. The environment has no `gh` CLI, and the browser is signed out of GitHub; the available GitHub UI returned a sign-in/404 page for this private repository.

## PR #3 review follow-up (2026-11-05)
- Minu's requested workspace formatting was applied with `pnpm exec prettier --write .`; `pnpm format:check` now passes, so CI runs it after lint.
- Updated `.env.example` usage guidance and the project/M00 status wording. Product M00 remains `INTEGRATED`; closeout chore PR #3 remains `IMPLEMENTED_PENDING_REVIEW` pending Minu's re-review.
- With Node 24.22.2, pnpm 12.16.1, and placeholder `DATABASE_URL`: frozen install, lint, typecheck, tests (3 files / 9 tests), build, and format check all passed. CI on the follow-up head remains pending.
- Next exact action: push the review fixes to `chore/m00-closeout` and request Minu's re-review; only the owner merges after written approval.


## 2026-11-16 — Owner-assigned Wave 0 foundations follow-up

State: IMPLEMENTED_PENDING_REVIEW; this does not change prior integration history. Scope: the explicit owner Wave 0 assignment authorizes shared contracts, the additive migration, offline seed, fresh-install bugs 1–5 and local tooling. Decision PR #110 is separate. See [exact changed files, verification and handoff](../../docs/WAVE0_FOUNDATIONS_STATUS.md). No ci.yml or PROJECT_STATE edits; no approval, live-provider acceptance or merge is claimed. Next action: official Minu review of the exact heads and SQL, then owner-controlled squash integration.


## 2026-11-16 — Issue #112 official review follow-up

IMPLEMENTED_PENDING_REVIEW. Addressed #111 B1–B8 and paid-script retry note against issue #112 (all source comments); #110 corrected first at ef34d69. One draft migration edited in place, exact seven agent prompt roles and all downstream contract fields provided. Updated deprecation ownership and default genre fallback; split planning assemblies to respect size limits. Evidence/changed files: ../../docs/WAVE0_FOUNDATIONS_STATUS.md. Next: official Minu re-review; integrate #110 before #111, squash only after approval. No merge or approval claimed.

## 2026-11-27 — Issue #169

Owner-assigned live-smoke repairs on `fix/live-smoke-169` against `6d7a5c4`. The additive usage-category migration also corrects historical reservations for identified run attempts. Next.js retains its screen-reader route announcer. The working tree is for operator review.

Changed files by directory

- `.` — `.env.example`, `.gitignore`, `README.md`, `package.json`
- `apps/api/src` — `app.module.ts`
- `apps/api/src/modules/channel` — `brief.integration.test.ts`, `brief.service.ts`
- `apps/api/src/modules/idea/discovery` — `scout.test.ts`, `scout.ts`, `service.test.ts`, `service.ts`, `text-calls.ts`
- `apps/api/src/modules/identity` — `csrf.http.integration.test.ts`
- `apps/api/src/modules/openai` — `provider-ledger.ts`
- `apps/api/src/modules/orchestration` — `video-run.engine.ts`
- `apps/api/src/modules/runs` — `audit-recovery.integration.test.ts`, `runs.control.ts`, `runs.controller.ts`, `runs.events.test.ts`, `runs.events.ts`, `runs.fixture.ts`, `runs.queue.ts`, `runs.service.ts`, `runs.transport.integration.test.ts`, `runs.types.ts`, `session-lock.ts`
- `apps/api/src/modules/scene-media` — `MEDIA_PIPELINE.md`, `media-prices.ts`
- `apps/api/src/modules/usage-budget` — `effective-budgets.ts`, `run-admission-state.ts`, `run-envelope.test.ts`, `run-envelope.ts`, `run-paid-admission.ts`, `run-paid-failure.ts`, `run-paid.ts`, `run-step-category.test.ts`, `usage-budget.ledger.ts`, `usage-budget.service.ts`, `usage-budget.types.ts`
- `apps/web` — `next-env.d.ts (removed)`, `next.config.ts`, `tsconfig.json`
- `apps/web/app` — `globals.css`
- `apps/web/app/account` — `page.tsx`
- `apps/web/app/channels` — `page.tsx`
- `apps/web/app/channels/[channelId]` — `page.tsx`
- `apps/web/app/channels/[channelId]/brief` — `page.tsx`
- `apps/web/app/runs/usage` — `page.tsx`
- `apps/web/components` — `auth-form.tsx`, `auth-mounted.test.ts`, `auth-session.test.ts`, `auth-session.ts`
- `apps/web/components/ui` — `page-heading.tsx`
- `apps/web/features/approvals` — `approval-panel.tsx`
- `apps/web/features/brief` — `channel-overview.tsx`, `editor.tsx`, `fields.tsx`, `onboarding-fields.tsx`, `onboarding.tsx`, `production-fields.tsx`, `screens.test.ts`, `studio-settings.tsx`, `wizard-location.ts`
- `apps/web/features/brief/verification` — `browser.spec.ts`
- `apps/web/features/timeline` — `client.ts`, `new-short.test.ts`, `new-short.tsx`, `progress-stream.tsx`, `run-list.tsx`, `run-screen.tsx`, `screens.test.ts`, `view-model.ts`
- `apps/web/lib` — `brief-bundling.test.ts`
- `apps/worker/src/handlers/orchestration` — `video-runs.test.ts`, `video-runs.ts`
- `docs` — `WORK_LOG.md`
- `packages/ai-providers/src/v2` — `adapters.test.ts`, `text.ts`
- `packages/contracts/src` — `channel-brief.test.ts`, `channel-brief.ts`, `run-experience.ts`
- `packages/database/prisma` — `schema.prisma`
- `packages/database/prisma/migrations/20261127020000_music_usage_category` — `migration.sql`
- `work-packages/M00-repository-governance-and-shared-contracts` — `STATUS.md`

Verification on Node 24.22.1 and pnpm 12.16.1, with UTC PostgreSQL and Redis DB 1

- `pnpm db:migrate:deploy` applied `20261127020000_music_usage_category` to the disposable database. `MIGRATION_BASE_REF=origin/main pnpm db:check-migrations` exited 0 with 43 ordered migrations.
- `pnpm vitest run <changed test files>` exited 0 with 105 tests in 17 files. The first run for the updated `auth-mounted.test.ts` also exited 0 with 5 tests. The browser spec was edited but Playwright was outside the requested verification scope.
- `pnpm --filter @reelforge/<package> typecheck` exited 0 for database, api, contracts, ai-providers and worker. Web exited 1 at the pnpm level with two TypeScript diagnostics. Corrected the auth form's out-of-scope variable and the test's React props type.
- Changed-file `pnpm exec oxfmt --check` exited 0. Changed-file `pnpm exec oxlint --deny-warnings` exited 1 with two function length and two return type diagnostics. Extracted the run budget component, named the editor scope and annotated the two callbacks. The first lint and format checks on the updated mounted auth test also exited 0. Subsequent edits were formatted.
