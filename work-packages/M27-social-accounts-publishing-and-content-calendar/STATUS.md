# M27 Status - Social Accounts, Publishing & Content Calendar

- **State:** BLOCKED
- **Assigned session/editor:** M27 developer
- **Branch/worktree:** `work/m27-publishing-and-calendar-ui` / `reelforge-m27`
- **Last updated:** 2026-11-13
- **Reviewer:** Core Architect/Reviewer
- **Approved commit:** none

## Current objective and completion estimate

0% implemented. Deliver the M27 UI after the backend gaps below are resolved or the acceptance criteria are revised.

## Task checklist

- [ ] M27-T01 through M27-T09: implementation and verification remain outstanding.

## Files changed

- This status and the append-only work log document the investigation and blocker.

## Commands and evidence

- `git fetch origin && git worktree add ../reelforge-m27 -b work/m27-publishing-and-calendar-ui origin/main` — passed.
- Inspected the publishing and social-account controllers, validation schemas, relevant service paths, and review pending-mark pattern. No tests, lint, format, typecheck, or build were run; no implementation is claimed.

## Contract/schema proposals

- Expose workspace-scoped platform connection availability based on configured and verified connectors, without disclosing credentials.
- Support a client-generated idempotency key on post creation, persisted and scoped to the workspace, with repeat requests returning the original post and conflicting payloads rejected. Provide a lookup/recovery path for interrupted requests, including unscheduled drafts.
- Return OAuth success and failure to an authorized frontend route with a safe, validated redirect and no provider secrets in the URL; preserve one-use state validation.

## Blockers / risks / unknowns

- No platform configuration endpoint exists; account capabilities describe existing accounts and cannot establish connection availability before the first account exists.
- Post creation generates server-side IDs and keys, and the calendar excludes unscheduled drafts. A lost create response cannot be reliably reconciled, so client-side pending marks alone cannot safely recover the created post.
- The OAuth callback responds with JSON or an API error, rather than returning the user to the UI.
- Backend changes are outside the authorized implementation scope. These proposals require Core assignment and review.

## Next exact action

Review and assign the backend proposals or revise the requirements, then resume M27 against the approved interfaces.

## Reviewer decision

Pending.

## 2026-11-13 Core decision follow-up

Minu approved D1–D3 in PR #93. Their initial backend implementation is in progress and is not yet verified against the required new tests or migration integration. No UI has been implemented.

A further interface gap blocks the composer: `GET quality/queue` only returns `REVIEW_REQUIRED`, `BLOCKED`, and `AI_REVIEW_UNAVAILABLE` runs, while `GET quality/renders/:renderJobId/status` returns the status and gates but not the review-run ID. `POST publishing/posts` requires `qualityReviewRunId`. Thus an approved render cannot be selected and submitted using the existing read interfaces. Proposed resolution: a workspace-scoped, paginated publishing read endpoint that returns eligible render IDs and their current approved review-run IDs, filtered to `APPROVED` / `AUTO_APPROVED` and non-superseded runs, with channel identity; alternatively, expose the current review-run ID on the quality status endpoint. Core decision/assignment is needed before expanding the approved backend scope.

Evidence since the original investigation:

- `PATH="$HOME/.nvm/versions/node/v24.22.2/bin:$PATH" pnpm install --frozen-lockfile` — passed.
- `PATH="$HOME/.nvm/versions/node/v24.22.2/bin:$PATH" DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55440/reelforge?schema=public' pnpm exec vitest run apps/api/src/modules/publishing/publishing.service.test.ts apps/api/src/modules/publishing/publishing.validation.test.ts apps/api/src/modules/social-accounts/social-accounts.service.test.ts` — passed: 3 files, 31 tests. These are existing tests and do not establish acceptance of the new interfaces.
- An initial API typecheck failed on an optional Prisma field; the field was corrected. The repeat result is recorded separately below when available.
- Repeat `PATH="$HOME/.nvm/versions/node/v24.22.2/bin:$PATH" DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55440/reelforge?schema=public' pnpm --filter @reelforge/api typecheck` — passed.
