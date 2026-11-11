# Production CI hardening

The CI workflow is a deterministic, least-privilege PR and `main` gate. It uses
the pinned Node and pnpm versions from the repository, a disposable PostgreSQL
18.6-alpine service for migration and database-backed test jobs, and no
repository secrets, protected environments, deployment steps, or live provider
calls.

## Enforced checks

The `required` job is the single branch-protection status to require. It only
passes when every mandatory job passes: `quality`, `database`, `tests`, and
`build`. A failed, cancelled, or skipped mandatory job cannot be reported green.
Each job has a finite timeout and the workflow cancels superseded runs for the
same repository and source branch. Pull requests use `github.head_ref`; pushes
use `github.ref_name`, so fork branches and unrelated branches do not collide.

`database` runs `db:validate`, the migration-order/immutability guard, and
`db:migrate:deploy` against a fresh disposable database. Existing migration SQL
files are immutable; changes must add a new timestamped migration directory.

The security job also scans tracked text files for common private-key and token
signatures. This local signature scan is enforced, while dependency audit is
report-only; neither control sends repository contents to a third party.

## Report-only controls

The `security` job runs `pnpm audit --prod --audit-level=high --json` and uploads
the bounded JSON result for 14 days. It is deliberately report-only while the
existing dependency baseline is triaged; it does not turn historical or
unreviewed findings into a false green or block unrelated changes. New findings
must be reviewed and either fixed or documented with an owner and expiry before
this control becomes blocking. No third-party secret-scanning service or paid
provider is invoked by CI.

The planned browser E2E/WCAG/visual regression, scheduled audit, SBOM/provenance,
and deployment workflows remain separate proposals and are not included here.
