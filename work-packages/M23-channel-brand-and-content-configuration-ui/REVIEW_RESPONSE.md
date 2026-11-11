# PR #49 review follow-up

Review: [owner technical comment](https://github.com/imTusharsingh/reelforge/pull/49#issuecomment-6796065264) on `659c63c`. This comment is not Minu's independent approval.

## R1 — BLOCKED: verified membership role / full CRUD acceptance

No backend/auth/shared contract approval was granted by the review. Production ChannelsScope still constructs an UNKNOWN-role client; all privileged forms and requests deny writes. No OWNER inference or local-storage role input was added. The existing contract proposal remains pending. No limited read-only merge decision or full M23 CRUD acceptance is claimed. Real role-aware UI and revocation/session acceptance require Core's approved contract and follow-up implementation.

Mock OWNER/EDITOR/VIEWER values are confined to test fixtures. They exercise frontend behavior at a test seam and are not evidence of a deployed role contract.

## R2 — implemented: explicit navigation and recovery

- Shared `studio-navigation.ts` exposes explicit route, history, workspace, logout and selection intents. Studio links and the two shared session controls call the intent gateway; there is no document-click capture or literal button-text matching. Programmatic routing uses `navigateWithIntent` before starting a route transition.
- A root client guard handles route navigation and native unload. Indexed history rollback handles rejected Back/Forward traversals before Next's popstate handler, preserving the forward stack. Chromium's Navigation API and the fallback history path are covered.
- Draft cancellation/confirmation is exercised at desktop/mobile widths, by keyboard and with icon-labelled session actions. The real Next application was also checked for Back cancellation and shared-shell navigation.
- Interrupted saves are explicitly uncertain, not assumed rolled back. Only path metadata is retained per workspace; recovery refreshes reads and displays an inspection/acknowledgement prompt. The request layer blocks blind resubmission until the pending outcome is reconciled. Cancelled/late responses cannot update a new workspace/role context.

## R3 — implemented: creator controls

- Group assignment uses a named series picker restricted to the current channel's returned series.
- Group membership uses a named published-version picker restricted to the selected character; DRAFT versions are excluded. Fixed request IDs come from the selected validated entities.
- Genre topics/duration/safety, character traits/voice/palette/variations and common schedule fields have labeled controls. Advanced JSON remains available and preserves unedited settings.
- Narrow form styles use existing design tokens and contain controls at phone widths. No M21/M29 header redesign or Issue #48 work was included.

## R4 — implemented: invalidation and draft rebasing

Every successful form mutation invalidates workspace-scoped resources, including channel snapshot selection, workspace activation and prompt activation/rollback. Active channel, workspace and prompt state is read back from the server. Refresh does not unmount existing editors. Pristine drafts adopt changed fetched initial values; dirty drafts keep edits and present an explicit latest-values reload action. Mounted tests cover both paths and snapshot/prompt active-state updates.

## R5 — implemented: DTOs and mounted tests

Feature-owned DTOs/parsers now cover channels, genres, series, characters/immutable versions, asset references/metadata, nested groups/members/assignments, snapshots and prompt templates/versions. They validate consumed fields, UUIDs, enums, versions, checksums, ownership and nested parent/reference relationships. Channel arrays are parsed rather than asserted as Channel[]. Generic ApiObject is retained for open JSON policy data.

New fixtures contain realistic M02–M05 payloads and malformed/foreign ownership variants. The checked-in standalone browser runner mounts actual components and covers saves, refreshes, dirty/pristine rebasing, structured edits, scoped pickers, snapshot/prompt state, navigation, context changes and uncertain requests. It runs outside normal application routes and does not add root dependencies or change CI configuration.

## Optional R6 polish

`RecordValue` was renamed `ApiObject`. The remaining naming/route-registry suggestions are optional and are not represented as completed requirements.

## Validation

- Full Vitest: **578 passed, 8 skipped**, 85 files passed / 2 skipped.
- Focused frontend: **67 passed**, 11 files.
- Mounted Chromium runner: **16 checks passed**, including desktop/mobile/fallback history and prompt rollback.
- Production build, workspace typecheck, lint, Prisma validation, 27-migration guard: **PASS**.
- Real local API/Next smoke: **PASS**, including Back cancellation, shared navigation, all six tabs, selected-workspace isolation, deterministic previews, Operations preservation and logout.
- Format, secret scan (526 tracked files) and diff checks: **PASS**. Exact-head hosted CI is checked after push; no pre-push hosted success is assumed.

The shared changes are confined to the navigation helper/link/guard, two explicit session-action calls, root guard installation and form styles. Authentication ownership, WorkspaceProvider, Overview and Operations remain intact. No self-approval or merge.

## 2026-11-11 — R1 backend contract integrated into M23 branch

Core-owned authenticated workspace-role contract [PR #51](https://github.com/imTusharsingh/reelforge/pull/51) merged to main at `05fa1a5c6138dea68c1a7d240fadfab4c95e8a56`. M23's branch merged that main commit, then updated the authenticated workspace list parser to **require** a server-issued OWNER/EDITOR/VIEWER role. Workspace creation's role-free acknowledgement is no longer eligible for selection; the UI requires a successful authenticated list refresh. Shared WorkspaceProvider passes that verified role into ChannelsScope. OWNER/EDITOR frontend forms may now submit, VIEWER remains read-only, and backend authorization stays authoritative.

This changes the prior R1 status from **blocked by missing API contract** to **role-aware wiring implemented, awaiting role-aware browser acceptance**. Do not claim live OWNER/EDITOR/VIEWER and revocation browser checks are passed unless actually run against the merged backend. The existing mounted fixture checks used mock roles. Revalidation after membership revocation and 403 feedback remain important follow-ups.

M29 privileged UI enablement is **deferred** to [Issue #52](https://github.com/imTusharsingh/reelforge/issues/52) because the dormant BudgetEditor and shared mutation cancellation paths have unresolved review findings. M23 deliberately retains Operations' existing UNKNOWN/read-only guard rather than enabling those actions without independent regression testing.
