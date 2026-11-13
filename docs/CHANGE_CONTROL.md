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

## Issue #69(A) — controlled architecture incorporation

Documentation incorporation authorized by [Manager A-DOC-01](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832566412). These references record independent architecture decisions, not application implementation authorization or PR approval.

- [CC-69-A-01 / ADR-021 revision 2](proposals/issue-69-a/frozen/CC-69-A-01_ADR-021.md): M08 paid-operation boundary and M18 accounting; accepted in #6832215027.
- [CC-69-A-02 / ADR-022](proposals/issue-69-a/frozen/CC-69-A-02_ADR-022.md): conservative publishing intake and bounded recovery; accepted in #6832033899.
- [CC-69-A-03 / ADR-023 revision 2](proposals/issue-69-a/frozen/CC-69-A-03_ADR-023.md): schema architecture and preservation; accepted in #6832215027, exact SQL NOT APPROVED.
- [CC-69-A-04 / ADR-024](proposals/issue-69-a/frozen/CC-69-A-04_ADR-024.md): audit cursor, stop compatibility and fatal-process safety; accepted in #6832033899.

Original PENDING proposal text is preserved; [decision record](proposals/issue-69-a/CORE_DECISION_RECORD.md) identifies the exact accepted versions and downstream gates. ADR-020 and final status/PROJECT_STATE reconciliation remain Workstream E-owned. WORK_LOG and package STATUS evidence appends await separately coordinated ownership.
