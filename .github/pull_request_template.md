Refs #<issue>

State the concrete problem and resulting behavior. Include scope, non-scope,
dependencies/blockers, unsupported capabilities, security/tenant/role/retry
results, exact changed-file owners, ADR/change-control decisions and status/log
reconciliation. Do not claim acceptance from a checkbox or CI alone.

Provide exactly one JSON record below. List every current and previous renamed
path. Acceptance rows require actual commands and evidence locations; repeat one
row per required criterion listed in `.github/process-policy.json`. Record three
complete runs for each infrastructure test mode and all failures/skips. BLOCKED
or DEFERRED rows require independent authorization exceptions for their IDs.

```json
{
  "kind": "reelforge-process-v1",
  "issue": 69,
  "authorizationComment": 0,
  "base": "<40-character base SHA>",
  "head": "<40-character head SHA>",
  "files": [],
  "scope": "",
  "nonScope": "",
  "dependencies": "",
  "limitations": "",
  "reconciliation": "",
  "reviewer": "minu-the-reviewer",
  "status": "IMPLEMENTED_PENDING_REVIEW",
  "acceptance": [
    {
      "id": "install",
      "command": "pnpm install --frozen-lockfile",
      "result": "PASS",
      "evidence": "<actual result and log location>"
    }
  ]
}
```

Link exact-head CI and independent authorization/ADR decisions. Minu must formally
APPROVE the latest head after blocking findings are resolved. The integrator
freshly revalidates both Required CI and Process Policy, authorization records and
protected blobs immediately before an owner-authorized squash merge. See
`docs/PROCESS_ENFORCEMENT.md` for bootstrap and unprotected-main limitations.
