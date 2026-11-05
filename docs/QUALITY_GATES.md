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
