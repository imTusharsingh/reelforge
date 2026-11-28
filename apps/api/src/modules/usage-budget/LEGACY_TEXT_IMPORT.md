# Paid text upgrade

Deploy the additive migration with `PAID_TEXT_V3_ENABLED` disabled. Pause paid-text
admissions, recovery, owner confirmation and relevant credits. Drain or terminate
all old writers (including workers, API processes and operator jobs). Do not
restart any old writer after the import or enable the new runtime before review.

Before enabling, configure an explicit, persistent `STORAGE_LOCAL_ROOT` shared
by paid sender and recovery processes. The local adapter's OS-temp fallback is
not suitable for paid evidence recovery. In a disposable environment, make one
fake provider return a definitive response while journal ingestion is unavailable,
stop that sender, and verify that a separate recovery process can read the same
spool, settle once, and make no repeat POST.

With the API built and `DATABASE_URL` supplied explicitly by the operator, run:

```sh
node apps/api/dist/modules/usage-budget/legacy-text-import.cli.js --workspace WORKSPACE_UUID
node apps/api/dist/modules/usage-budget/legacy-text-import.cli.js --workspace WORKSPACE_UUID \
  --apply --old-writers-drained --audit-id CHANGE_RECORD
node apps/api/dist/modules/usage-budget/legacy-text-import.cli.js --workspace WORKSPACE_UUID
```

The default is dry-run. It shows per-attempt before/after reserved, gross
committed and net amounts without exposing payloads. The apply acknowledgement
must cover every process that could still send or change accounting; an expired
lease or closed database connection is not proof of drain. The applied import
records the audit ID and exact historical source keys in each run.

A matching legacy send event or verified Google receipt is positive send
evidence. A bare marker remains held without owner eligibility. A provably
unarmed preparation closes at zero. A pre-POST release requires the exact
attempt, dispatch/reservation key, canceled step and matching zero-cost
NOT_DISPATCHED ledger plus its own release event. A release on another step
cannot authorize retry. An owner-reported interaction ID is not Google evidence.
Only exact adjustment-audit links or existing scoped adjustment FKs become
linked credits; a correlation ID alone is insufficient.

Apply is idempotent. Existing posted charges are seeded and not booked again;
already-stored but not yet posted completions remain for the normal evidence
fold. Review every blocked row (exit 2) and all changes to reserved funds,
commitments, credits and net exposure before enabling a new sender. The importer
makes no provider calls.

The report lists unresolved standalone credit IDs in `unresolvedCreditIds`.
Any such ID blocks the workspace import and returns exit status 2. Reconcile
the original adjustment to a scoped charge using its audit evidence, or document
a genuinely independent budget credit before enabling reversals. The adjustments
endpoint accepts `BUDGET_CREDIT` for independent budget adjustments. A charge
`CREDIT` requires the original text attempt ID and a unique operation key.
