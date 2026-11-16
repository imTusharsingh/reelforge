# Quality Gates and Review Checklist

## Gate 0 - Ready to assign

- [ ] Work package has objective, scope, non-scope, dependencies, tasks, interfaces, and acceptance criteria.
- [ ] Shared contracts required by the block are approved.
- [ ] Block branch/worktree is isolated.
- [ ] Current project state and module status are readable.

## Gate 1 - Implementation complete (bot-reported)

- [ ] Tasks implemented or blocked with explicit reason.
- [ ] No edits outside the assigned module except approved files.
- [ ] Exact changed-file list is written.
- [ ] Tests and command outputs are recorded accurately.
- [ ] No fake production provider/platform behavior.
- [ ] No unapproved live external call.
- [ ] Handoff/status/work log updated.

## Gate 2 - Core review

- [ ] Scope and boundary compliance.
- [ ] TypeScript strictness and runtime validation.
- [ ] Authorization and workspace isolation.
- [ ] Error handling and failure states.
- [ ] Idempotency and retry correctness.
- [ ] Secrets/log redaction.
- [ ] Database constraints/indexes/migration safety.
- [ ] Provider capability and API assumptions verified.
- [ ] No hidden network call in startup/health/seed/CI.
- [ ] No fabricated success or data.
- [ ] Tests actually pass when reviewer reruns them.
- [ ] Docs/contracts/status agree with implementation.

## Gate 3 - Integration

- [ ] Contract versions match producer and consumer.
- [ ] Event payloads validate at both ends.
- [ ] Database migration is integrated once and in correct order.
- [ ] Cross-module state transitions work.
- [ ] Failure and retry paths are exercised offline.
- [ ] No duplicate publish/generation side effects on retry/restart.
- [ ] Build, lint, typecheck, unit, contract, and relevant integration tests pass.

## Gate 4 - Live provider verification (separate authorization)

This is not a normal coding gate. It requires explicit project-owner authorization and is performed by an operator or designated integration session.

Record before execution:

- Provider/platform and API operation.
- Account/channel identity and environment.
- Exact requested permissions/scopes.
- Expected provider charge, quota, or rate-limit consumption.
- Maximum spend and number of attempts.
- Target visibility and whether an external audience can see the result.
- Cleanup/rollback procedure.
- Exact command/operator and timestamp.

After execution, store sanitized evidence (never tokens) and actual result. A live call tests only the exact capability and account configuration exercised.

## Gate 5 - Release

- [ ] Critical/blocking security findings resolved.
- [ ] Budget and rate-limit protections active.
- [ ] Publishing requires approval policy and hard gates.
- [ ] Emergency pause works.
- [ ] Operational dashboard/logs show job and failure state.
- [ ] Backup/retention/deletion behavior is documented.
- [ ] All release notes and project history are updated.


## Wave 0 local quality tooling

Owner-assigned foundations add exact dev pins: Knip 6.22.0, @vitest/coverage-v8 5.1.0 and jsdom 27.3.0 (offline React recovery tests), following ADR-012. CI wiring remains a separate chore; ci.yml is unchanged.

- `pnpm knip`: compares stable file/export/dependency findings against `knip-baseline.json`, captured from main bb39fc3 using the committed configuration. New findings fail. `pnpm knip:baseline` is an explicit maintainer operation; review any added debt, never regenerate merely to pass a gate.
- `pnpm lint` / `pnpm lint:size`: ESLint with zero warnings. New source uses 400 nonblank/noncomment lines per file and 60 per function. `eslint-size-baseline.json` grandfathers main's larger files/functions; test suite assembly is exempt from function length. This makes the guideline enforceable without unrelated refactors.
- `pnpm test:coverage:changed`: runs the full Vitest suite with v8, then requires at least 80% lines and 70% branches on changed executable code in apps/packages against `origin/main` (override with COVERAGE_BASE). Stage new files first; the gate refuses untracked deliverables. `--check-report` on the underlying script checks an already generated report. Tests, fixture assembly, generated code and declarations are excluded. Reports go to ignored `work/coverage/`.
- `pnpm quality`: strict lint, typecheck and the Knip baseline check. The final full suite remains separate so it can be run once after implementation and immediately before opening the PR.
