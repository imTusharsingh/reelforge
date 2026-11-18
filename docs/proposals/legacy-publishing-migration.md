# Legacy workflow, review, and publishing migration proposal

This is a proposed integration plan, not approval to migrate or delete data. It reflects a source
inspection of the current V6 branch; it does not inventory any deployed database.

## Current consumers

| Surface | Current consumers and retention requirement |
| --- | --- |
| M16 workflow | The orchestration controller, scheduler, queue, worker, operations views, and historical workflow records still use its definitions, jobs, leases, and events. Generation is gated when `pipeline.v2` is enabled, but other workflow definitions remain active. Drain and migrate each definition before removing these paths. |
| M11 review | The quality controller reads historical reviews and accepts decisions. The workflow dispatcher resumes an existing review. M13 checks the current review and revalidates rights and provenance before post creation and delivery. Retain these readers and decisions while historical posts depend on them. |
| M13 publishing | Historical scheduled posts retain render/review identifiers. New VideoRun posts use the run, exact critic step, assembly step, manifest and final artifact checksum. Preflight and delivery revalidate approval, policy, rights, provenance, technical and budget evidence. |
| VideoRun publishing | Automation binds directly to successful `CRITIC` and `ASSEMBLING` steps. No synthetic `PACKAGING` step or legacy render/review identifiers are created. |

Evidence: [automation service](../../apps/api/src/modules/publishing/automation.service.ts),
[publishing preflight](../../apps/api/src/modules/publishing/publishing.service.ts),
[critic output](../../apps/api/src/modules/quality/run-critic.ts),
[VideoRun engine](../../apps/api/src/modules/orchestration/video-run.engine.ts),
[temporary package contract](../../packages/contracts/src/publishing-automation.ts), and
[schema](../../packages/database/prisma/schema.prisma).

## Proposed sequence

1. **Deployment prerequisite:** inventory deployed rows by workspace and status, including in-flight workflow jobs, reviews,
   scheduled posts, destinations, attempts, upload receipts, and retention obligations. Record
   foreign keys and object-storage references; verify restorable backups and reconciliation state.
2. **Implemented locally:** specify and review a versioned VideoRun publishing source containing the run, exact successful
   critic attempt, immutable assembly manifest and media checksum, validated packaging and cover
   evidence. Specify publish-time revalidation of actor permission, emergency stop, current approval,
   policy, rights, provenance, technical and budget gates. Missing or stale evidence blocks publish.
3. **Implemented locally:** design an additive persistence change that distinguishes historical render/review sources from
   VideoRun sources with tenant-scoped constraints and unambiguous source selection. Preserve old
   identifiers and receipts; do not synthesize historical approvals or translate IDs. Review exact
   SQL, lock behavior, backfill rules and restore/rollback procedure before deploying a migration.
4. **Implemented locally:** extend M13 preflight and delivery to consume the new source while retaining its upload
   idempotency, quota, lease, uncertain-outcome reconciliation, OAuth and disclosure checks. Bind
   automation to the actual critic result and assembly, not an invented packaging step or review.
5. Add offline end-to-end tests for approval, scheduling, verified media, a fake upload, retries,
   revocation and uncertain outcomes, stale and foreign evidence, and historical post compatibility.
   Run database and worker restart tests with disposable PostgreSQL and Redis before enabling it.
6. Cut over in stages with monitoring and rollback, then drain or explicitly resolve old work.
   Remove an old endpoint or table only after all consumers and retention needs are accounted for;
   destructive schema removal requires a separate approved ADR and migration.

## Unresolved decisions

Source-selection and schema design, how existing approvals remain actionable, storage retention,
historical scheduled-post handling, the cover artifact representation, rollback windows, and
deployment authorization need owner and architecture review. No production readiness or live
publishing claim follows from the local tests.
