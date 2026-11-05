# M00 Status - Repository Governance & Shared Contracts

- **State:** IMPLEMENTED_PENDING_REVIEW
- **Assigned session/editor:** Codex implementation session
- **Branch/worktree:** `work/m00-monorepo-foundation`
- **Last updated:** 2026-11-05
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** none

## Current objective
Establish repository rules, engineering quality gates, shared contracts, initial schema, CI, and bot coordination.

## Session scope summary (2026-11-05)
- **Requested tasks:** M00-T01 through M00-T07: monorepo/tooling, minimal app/package bootstraps, shared contracts/events, Prisma baseline/migration policy, offline CI, governance templates/instructions, and contract versioning policy.
- **Dependencies:** None listed; M00 is the first block. No application code exists in the inspected planning pack.
- **Likely files:** Root workspace/tooling/CI configuration; `apps/{web,api,worker}/`; `packages/{contracts,database,config-engine,ai-providers,social-providers,media,observability,shared}/`; root contributor/editor instructions; this status file and `docs/WORK_LOG.md`.
- **Repository state:** Initial commit `773c1792dc9369172e8431944d979754dc9a1b30` from `main`; assigned branch `work/m00-monorepo-foundation`.
- **Ownership:** Resolved by Core Reviewer; this M00 session is authorized to edit its shared files.
- **Unknowns:** None blocking implementation. GitHub CLI and an authenticated GitHub PR creation tool are unavailable in this session; the branch is pushed and the PR creation link is ready.

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
- Packages: `packages/{contracts,database,config-engine,ai-providers,social-providers,media,observability,shared}/**`.
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

## Contract/schema proposals
- For Core review: first versioned event payloads (`PostPublished`, `PublishFailed`), API error/pagination schemas, and the foundation Prisma table set described below. All use the frozen workspace tenant boundary and event-envelope fields from the canonical pipeline.
- Foundation Prisma models: `User`, `Workspace`, `WorkspaceMembership`, `Channel`, `ContentSeries`, `Asset`, `Video`, `Post`, `WorkflowRun`, and `OutboxEvent`. These are intentionally baseline records; module-specific states/configuration remain out of this schema.

## Blockers / risks / unknowns
- The sandbox blocks Next.js spawning TypeScript for `--showConfig`; the full build passed outside the sandbox. A sandboxed frozen-lockfile reinstall also hit a read-only store lock, while the initial install passed with registry access.
- Initial lockfile resolution exposed incompatible TypeScript 7.0.2; the pin was corrected to 6.0.3, within typescript-eslint's documented peer range `>=4.8.4 <6.1.0`. Full install then reported a blocked `msgpackr-extract` build script; its approval is now explicit in pnpm config. Prisma v7's documented Node range excludes Node 26, so Node was pinned to compatible LTS 24.22.2.

## Next exact action
Open the PR from the pushed branch using the handoff link, then request Core review without merging.

## Handoff notes
Ownership question resolved by the Core Reviewer; implementation and local verification are complete. Commit `41e654f` is pushed; PR creation awaits an authenticated GitHub UI/tool.

## Reviewer decision
- Pending.
