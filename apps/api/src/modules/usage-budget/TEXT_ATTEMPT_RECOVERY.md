# Operator recovery for paid text attempts

Use this runbook after the paid worker dies or its database acknowledgment is
lost. Normal recovery still imports durable worker spool evidence. This command
is a fallback for facts verified independently of the workspace owner. It makes
no provider request and never permits another POST on the arm.

Run with an operator-only, audited `DATABASE_URL`, against the intended
deployment, from the exact built API release. There is no HTTP endpoint and no
workspace-owner path to this command. A person who can write to the application
database can forge any record; protect and audit this credential. The CLI
verifies the record's shape, time and exact identity against the attempt, but it
does not authenticate an external supervisor/control-plane or provider/egress
record. Open the trusted source directly and verify it before filing a proof.
Do not transform owner input into provider evidence.

## Identify the exact arm

Use a tenant-scoped read-only lookup (bind the two UUIDs as query parameters):

```sql
select a.workspace_id, a.attempt_id, s.idempotency_key as dispatch_key, a.nonce,
       a.created_at, a.data->'sender' as sender
from text_attempt_evidence a
join video_run_steps s on s.workspace_id = a.workspace_id and s.id = a.attempt_id
where a.workspace_id = $1::uuid and a.attempt_id = $2::uuid and a.kind = 'ARMED';
```

Use these values in the proof's `target` object, with keys `workspaceId`,
`attemptId`, `dispatchKey`, `armNonce` and `incarnation` (from `sender`). No
other attempt, even a retry for the same run, is interchangeable. If the legacy
import already retired this arm, the incarnation is the literal
`drained-legacy-writer` from `a.data->>'incarnation'`, and it may be used only for
provider evidence, not as fresh proof of retirement. Its nonce has the form
`legacy:<reservation UUID>`; copy the exact value.

## Verify sender retirement

The `retire` proof contains `target`, `actor` (the operator's audited identity),
`reference` (the incident/change record), and one of:

- `source: "local-procfs"`: run in the original Linux boot and PID namespace,
  with the worker's effective UID and its normal procfs mounted. The command
  checks the stored PID/start ticks and refuses while that exact process is
  alive. PID reuse, a reaped process, or a kernel-listed dead/zombie process
  proves the original process can no longer send. Do not use a virtualized or
  selectively filtered procfs.
- `source: "supervisor-exit"`: record `result: "process-exited"`, `observedAt`
  (ISO timestamp after the arm), and the exact `sender` object from the
  supervisor's terminal record linked to the armed process. Verify the
  supervisor's trusted worker registration plus its immutable process/container
  ID and terminal observation. A deployment rollout, mutable pod name, lease
  timeout, disconnected DB session, or an unmatched PID is not process-exit
  proof. Preserve the linked records and their immutable references in the
  incident.

```sh
node apps/api/dist/modules/usage-budget/text-attempt-ops.cli.js retire \
  --proof /approved/exit-proof.json --apply
```

Retirement does not prove no send or release funds. An arm without positive
send evidence remains held and cannot be owner-confirmed. An older arm with no
recorded process identity cannot be matched by this command. For legacy arms
only, use the separately documented cutover import with a verified global
drain; a drain alone is not provider evidence.

## Import a matched Google receipt

After sender retirement, use a trusted Google project audit record or an
authenticated egress response record that independently associates the exact
outbound dispatch key with the Google-issued interaction ID. Verifying only
the Google ID, similar timestamps, matching prompts, or an owner claim is not
enough. The app uses `store:false`; a matching historic Google interaction may
not be available. If a trustworthy exact match cannot be obtained, leave the
attempt held. Do not call the create endpoint as a diagnostic.

Provide `target`, `actor`, `reference` (the immutable source record/record
locator), `observedAt` (when the operator independently verified the record,
after the arm or legacy import; the original record can predate import),
`source: "google-project-audit"` or
`"egress-response"`, and the distinct `googleId`. Include canonical `usage`
only if the same receipt supplies those counters. Include `actualMinor` and
`currency` only with an independently verified amount in the attempt's
currency. Do not copy prompts, output, API keys, authorization headers or raw
logs into a proof file.

```sh
node apps/api/dist/modules/usage-budget/text-attempt-ops.cli.js receipt \
  --proof /approved/provider-receipt.json --apply
```

The receipt proves send and may supply billing metadata, but never declares a
usable result. An ordinary held attempt then becomes eligible for the existing
owner confirmation. If previously confirmed, genuinely new billing evidence
can adjust its commitment without a new reservation or output. Contradictory
receipts are rejected. The original evidence stays append-only; after a
connectivity or settlement failure, safely replay the exact same proof. Keep
proof files outside the repo with operator-only permissions.

## Import a definitive Google rejection

If the same trustworthy source instead proves that the exact outbound request
was rejected, use the receipt proof shape except **omit** `googleId`, `usage`,
`actualMinor`, and `currency`. Supply the exact authenticated HTTP
`httpStatus` and provider `code`. The command accepts only the same typed
400/401/403/404 rejection pairs as the live transport. An intermediary error,
generic denial, absence of a receipt, timeout, 429 or 5xx does not qualify.

```sh
node apps/api/dist/modules/usage-budget/text-attempt-ops.cli.js reject \
  --proof /approved/provider-rejection.json --apply
```

An accepted typed rejection releases reserved funds or reverses a previous
owner-authorized commitment. It does not permit a second POST on the same arm.
