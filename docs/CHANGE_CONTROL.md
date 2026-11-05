# Scope and Change Control

## Purpose

Prevent features from appearing mid-implementation and avoid AI coding sessions quietly changing the design.

## Change classes

1. **Bug/correctness fix:** required to meet an existing acceptance criterion. May proceed within the block, then log it.
2. **Security/reliability fix:** required to protect users/data or prevent incorrect external side effects. Escalate immediately; may require expedited approval.
3. **Compatibility update:** required because an official provider/API/framework changed. Verify with authoritative source and record an ADR.
4. **Feature request:** new user-visible behavior, new integration, new workflow, or new configurable dimension. Out of scope until approved.
5. **Refactor:** internal restructuring that does not change behavior or contract. Must be justified and approved if it crosses module boundaries.

## Required proposal format

- Change ID
- Problem and evidence
- Proposed behavior
- User/business value
- Affected modules, APIs, schemas, events, prompts, and pipelines
- Cost, security, privacy, policy, reliability impact
- Backward compatibility and migration
- Acceptance criteria and tests
- Trade-offs and what moves out of v1
- Owner decision
- Core Reviewer decision

## Approval flow

`Proposal -> Owner decision -> Core architecture impact review -> ADR -> updated work packages/contracts -> implementation assignment`.

Until the ADR is approved, a coding bot must not implement the request. Do not treat a casual chat suggestion, TODO, generated idea, or competitor feature as approved scope.
