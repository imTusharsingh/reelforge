# Independent Core decision record — architecture accepted, implementation blocked

Verified source: [Minu decision #6832215027](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832215027), authored by `minu-the-reviewer`. Base reviewed: `18926530477d53b5dcb96ffa55f905eee1a02ce4`.

| Architecture       | Exact accepted posted text                                                                  | Decision                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ADR-021 revision 2 | [#6832104336](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832104336) | ACCEPT; former HIGH C1 resolved at architecture level only                            |
| ADR-022            | [#6831936692](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6831936692) | ACCEPT via prior decision #6832033899                                                 |
| ADR-023 revision 2 | [#6832104919](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832104919) | ACCEPT schema architecture/inventory only; exact SQL and lock/validation plan pending |
| ADR-024            | [#6831937795](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6831937795) | ACCEPT via prior decision #6832033899                                                 |

Acceptance attaches to the exact posted texts, not independently attested local hashes. Draft PENDING headers remain historical submission text; do not silently edit the accepted contracts. Changed contracts need renewed review. This record is not incorporation into the approved DECISION_LOG or evidence of implementation/integration.

## Engineering Manager handoff

1. Authorize the documentation process to incorporate the exact accepted ADRs and CC records, preserving append-only history and the distinction between original proposals and decisions. ADR-020 remains E-owned; PROJECT_STATE remains untouched.
2. Confirm the final exact owned-file inventory, including the revision-2 M08 recovery service, worker integration and verification files.
3. Separately issue final Gate 0 release with the migration sequencing boundary: exact migration SQL and its lock/validation plan need independent Core inspection before any migration execution. No SQL has been approved or created here.
4. Only after the required documentation incorporation and Manager release may implementation begin. Require actual T21-13..19 crash/expiry/lock/commit-ambiguity evidence, remaining acceptance tests, full mode runs and exact-head independent implementation review.

Current branch: `work/issue-69-a-core-remediation`; HEAD remains the base above. No push, implementation PR, source/shared-contract/schema/migration edit, application verification, live provider call, approval or merge occurred in this handoff. Local proposal/documentation work only. All Gate 1/2 evidence is outstanding.

**VERIFIED:** independent Core architecture acceptance and its exact scope. **PARTIAL:** formal documentation incorporation and final owned-file gate pending. **BLOCKED:** implementation and migration execution under the separate gates above.

## Documentation route authorized, not application release

Manager [A-DOC-01 #6832566412](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832566412) authorizes this isolated docs-only incorporation PR and exact path list. The preceding proposed incorporation handoff is historical; documentation is now prepared on `chore/issue-69-a-adr-incorporation` for independent review, not yet integrated. Application editing remains blocked. Exact SQL remains PROPOSED / NOT APPROVED. WORK_LOG/STATUS appends and PROJECT_STATE/ADR-020 are excluded. Final Manager application release remains required after the independent downstream gates.

## Current decision — 2026-11-13 IST

**SQL v1: REQUEST CHANGES / NOT APPROVED.** Independent [Minu exact-SQL review #6832724919](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832724919) issued an adverse decision; this is not merely an unreviewed candidate. The [subsequent SQL-01 disposition #6832990843](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832990843) resolves the suspected S1 cascade regression **only for the reproduced baseline graph**, not the full SQL proposal.

The distinct direct-hard-delete policy is still awaiting owner/Manager acknowledgement: new paid-operation NO ACTION references block direct channel/workflow/hold/request deletion while an operation exists; workspace cascade succeeded in synthetic fixtures. No detachment, purge or deferrable alternative is preapproved. SQL-02 operator-reviewed lock/timeout/validation/rollback procedure, SQL-03 paired Prisma schema/migration and preservation/zero-drift proof, and SQL-04 full CHECK/FK/financial transaction validation remain outstanding.

The scoped PostgreSQL reproduction evidence is [#6832944568](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832944568) and [#6832945162](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832945162): 42 cases and three workspace COMMIT probes, not execution of SQL v1 or complete application verification. The earlier “no A database command” and “NOT RUN” statements below describe the historical submission, not these later scoped reproductions. No application migration has been created or executed.

Keep SQL_REVIEW_PROPOSAL.txt as historical, unapproved v1. Independent Core acceptance of revised exact SQL and separate Manager authorization are required before any migration execution; application Gate 0 remains BLOCKED.
