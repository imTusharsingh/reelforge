# M23: trusted current-workspace membership role

Status: PROPOSED; Core approval and implementation required. No backend/shared contract change is included in this branch.

## Observed contract

`GET /api/v1/workspaces` returns authorized workspace IDs, names and archive state. It does not return the authenticated user's membership role. M29's shared WorkspaceProvider intentionally carries this existing workspace shape. M23 reuses that provider and stays UNKNOWN; it does not infer OWNER from workspace creation, successful reads, local storage, URL values or an editable control.

## Requested Core decision

Expose the authenticated user's verified membership role through a Core-owned API contract. One possible additive contract is a `role` field on each authorized workspace returned by the existing list endpoint, derived from that principal's membership row. Existing roles remain OWNER, EDITOR and VIEWER; no new role is proposed. An equivalent authenticated context endpoint is also acceptable if Core prefers it.

Core should specify validation, revoked-membership handling and refresh semantics. The frontend must treat missing/invalid role metadata as UNKNOWN, cancel pending reads/mutations on workspace or role change, and continue relying on server authorization for every mutation.

## Follow-up after approval

Integrate verified role metadata into the shared workspace provider, including M29 coordination. Supply it to M23's ChannelsClient and remount/cancel the module scope on role changes. Enable owner/editor forms only from this trusted context. Add browser tests for authorized editing, denied viewer mutations and revocation/downgrade during pending writes.

Until then, channel/genre/series/character/group/asset/snapshot writes remain disabled in product UI. Lists, saved-data inspection and the two explicitly allowlisted deterministic previews remain available. Backend API writes were separately exercised using a disposable authenticated owner; that does not establish the user's role in frontend context.

## Other existing-contract limits

- Blank optional M02 string fields are omitted. M02 does not support clearing them with empty strings/null; no clearing capability is fabricated.
- M04 asset metadata contains storage object keys, not browser preview URLs. No public URLs are invented.
- M03 character/prompt references are opaque; group assignments do not silently rewrite them.
- Publishing destinations are configuration intents, not proof of OAuth connection or provider capability.
