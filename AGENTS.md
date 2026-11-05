# ReelForge repository instructions

- Repository documents and approved ADRs are authoritative. Follow their source-of-truth order in `README.md`.
- Implement only the assigned work package. Do not edit other modules' work packages.
- Shared contracts, database schema/migrations, and root tooling are Core-owned; a written M00 assignment may explicitly authorize the M00 session to edit these within its scope.
- Use strict TypeScript and runtime validation at trust boundaries. Do not use `any` to bypass validation.
- No runtime provider adapter may fabricate success, data, IDs, or media. No live AI/social calls in startup, health checks, tests, migrations, seeds, or CI.
- Run checks that are available and record exact results. Never report unrun commands as passing.
- Do not mark work APPROVED, INTEGRATED, or DONE, and do not merge your own PR.
