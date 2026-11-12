# M25 backend capability audit

## Core resolution

Core issues #59 and #60 are merged on `main` at `f143d2e` and `58b946e`. M25 merged that main tip in branch commit `15dfd0a` and consumed only the approved contracts. The authorized media routes, persisted job discovery, server-derived capability catalog, observed revision creation, and versioned/idempotent mutation behavior are now implemented. Selected library-asset assignment remains explicitly absent by Core decision; the UI exposes the real gallery and labels selection unavailable while keeping the existing `{kind}` regeneration semantics.

Audited 2026-11-12 (Asia/Calcutta), main `7a81e0710b4c1ff6ae1375aacb3ef6d89634db0e` (merged M24 PR #55). Branch: `feat/m25-generation-studio`; worktree: `/workspace/reelforge-m25`. Static source audit only; no provider or application HTTP calls.

## Authorization and readiness

All routes below are relative to `/workspaces/:workspaceId`, protected by AuthGuard and WorkspaceService.context. Services scope records by workspace. Reads generally permit members including Viewers; scene provider-health and production mutations require Owner/Editor. Usage budget writes require Owner. UI role checks cannot replace server authorization.

SceneMediaModule binds all three provider ports to NotConfigured adapters. These are explicitly unavailable implementations, not configured vendor adapters waiting only for credentials. ProviderRegistry has in-process list/health methods, but there is no HTTP capability/model catalog. No live readiness is established. Composition has a real local engine; execution depends on storage, FFmpeg/ffprobe, valid complete inputs and worker processing. Environment status reports DATABASE_URL and STORAGE_DRIVER ready, no secret bindings; this does not establish deployed service readiness.

## Operation matrix

DTOs named below are existing module-local types, not new shared contracts. Source: `apps/api/src/modules/{script,scene-media,composition,asset,orchestration,usage-budget}` controllers, services, types and validation files; `packages/ai-providers/src/index.ts`.

| Task / operation | Actual endpoint and payload/result | Supported scope and safe invocation | Gap / disposition |
| --- | --- | --- | --- |
| T01 project/scene reads | GET `scripts`, `scripts/:scriptId`, `scripts/:scriptId/revisions`; GET `scene-media/jobs/:jobId` → SceneMediaPackage | Tenant-scoped persisted script revisions, scene status, output references; reads do not generate | No complete scene-job list. Workflow resultRef and usage cost lines provide partial discovery only; #60 |
| T02 generation | POST `scene-media/jobs` with scriptId, idempotencyKey, outputs (image:true; optional video/narration/dialogue) → SceneMediaPackage | Owner/Editor; approved script, snapshot pair, character references and provider budget required. May execute provider work inline; never invoke as readiness probe | NotConfigured bindings; no observed revision precondition; payload replay mismatch and pinned-input concerns in #60 |
| T03 provider/model choices | GET `scene-media/provider-health/:providerId/:capabilityId` → registry health; in-process CapabilityMetadata | Owner/Editor; requires known IDs; health callback may invoke provider-specific health | No HTTP catalog or request model choice; do not guess IDs or probe providers; #60 |
| T04 costs/budgets | GET `usage/videos/:scriptId`, `usage/runs/:runId` → CostBreakdownView; GET `usage/budgets` → BudgetStatusView[] | Member reads; authoritative totals/lines/reservations/budgets, explicit cost classifications | Preserve actual/estimated/unknown and currencies; render cost is NOT_TRACKED, never zero by inference |
| T05 progress/failure/retry | GET `orchestration/runs`, `runs/:runId` → WorkflowRunView; POST run cancel/retry/resume. GET scene job; POST scene job retry, scenes/:sceneId/regenerate | Persisted steps/jobs/events and scene output errors; Owner/Editor commands; orchestration retries can dispatch provider work | No scene cancel. Scene retry/regenerate have no observed revision/operation key, use current script plan; #60. Refresh must never replay uncertain commands |
| T06 asset gallery/replacement | GET `assets`, `assets/:assetId`, versions/usage → AssetRecord/AssetUsageRecord; POST scene `replace` with {kind} | Asset metadata/version/rights reads supported; replace regenerates a kind through provider | No asset assignment request; objectKey is not a URL; #59/#60 |
| T07 narration | Script revision document; SceneMediaPackage NARRATION/DIALOGUE outputs; creation outputs flags | Read exact pinned script narration and persisted audio metadata; generation unavailable | No independent voice/model selector or narration asset editing contract; do not modify approved inputs |
| T08 sequence/timeline | Script revision timing/order; RenderJobView.input → RenderCompositionInput; POST `composition/jobs/:jobId/edit` | Inspect pinned order/duration/captions; server validates composition edits and creates child jobs | Follow render constraints; no full nonlinear editor. Scene re-planning must be resolved in #60 before scene writes |
| T09 preview | GET `composition/jobs/:jobId` → RenderJobView; GET manifest → RenderManifest | Metadata and manifest reads; manifest requires successful complete artifact set and verifies stored bytes | No authorized browser media byte/URL delivery; #59 blocks real preview |
| T10 render/export/history | POST `composition/jobs` / `jobs/:jobId/retry` with validated input/idempotencyKey/retentionDays; POST cancel; GET manifest. GET `scene-media/jobs/:jobId/export` → complete SceneMediaPackage | Render creates durable jobs; retry pins fingerprint and bounded child lineage; scene export is JSON, not a video. Usage breakdown lists renderJobId/status | No video download route. No general render list; usage can discover render jobs per script. #59; complete production history decision #60 |

## Core decisions resolved

- [#59](https://github.com/imTusharsingh/reelforge/issues/59): closed by merged Core PR #62; M25 uses authenticated asset-version and render-artifact content paths.
- [#60](https://github.com/imTusharsingh/reelforge/issues/60): closed by merged Core PR #63; M25 uses complete discovery, capability availability, expected script revisions, observed job versions and operation idempotency.
- M25 made no shared contract, backend, schema, migration or root-tooling changes.
- `docs/PROJECT_STATE.md` still describes M19-era progress; latest main, WORK_LOG and the assigned package establish the actual M24 baseline. No architectural decision is inferred from stale progress text.

## Scoped implementation plan after Core resolution

1. Rebase this isolated branch on approved Core changes and re-audit contracts. Build `apps/web/features/generation` plus Next generation routes using verified workspace context, existing shell, primitives and design tokens. No provider SDK or direct database access in web.
2. Implement T01 persisted library/detail/scene reads, T04 classified costs, T07/T08 pinned narration and timing. Validate response DTOs at the web boundary; abort stale workspace requests and clear revoked access.
3. Implement T02/T03 unavailable states or approved server-driven choices, T05 explicit job recovery, and T06 only approved asset semantics. Use observed tokens, operation idempotency and explicit reconciliation after ambiguous writes.
4. Implement T09/T10 through the approved authorized media delivery contract, with missing/expired/error/loading states and actual history.
5. Add offline permission/tenant/race/recovery/media tests and desktop/mobile browser evidence; run required gates and record exact results. Self-review, push, open non-draft PR with `Closes #58`, request minu-the-reviewer, resolve feedback without self-approval/merge.

Implementation is paused before product changes under the mandatory audit stop rule in #58. Existing safe reads are identified above but no T01–T10 completion is claimed.
