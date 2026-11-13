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
