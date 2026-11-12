# Issue #69 Workstream F process enforcement

Implementation authority: Manager release [6832504863](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832504863).
Independent Core decisions: [6831915757](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6831915757)
(attestation and security separation) and [6832062521](https://github.com/imTusharsingh/reelforge/issues/69#issuecomment-6832062521)
(exact yaml 2.9.1). These are design approvals, not implementation or integration evidence.

## Outcomes and trust boundary

`Required CI` requires quality, database, tests, build and secrets to return success.
Failure, cancellation, skip or absence of a mandatory result blocks its aggregate.
Candidate inspection is bound to the actual `.github/workflows/ci.yml` path from
GitHub's directory inventory, never its author-controlled display name. The
expected event and seven-job topology is checked unconditionally. Removing,
renaming or moving Required CI, secrets, quality, database, tests, build or the
separate audit job fails closed. The scanner and aggregator must match their
approved structured jobs exactly: no job/step conditions beyond Required CI's
`always()`, continue-on-error, altered RESULTS, environment/shell overrides,
extra preparation steps, sparse/alternate checkouts, or muted/redirected scanner
invocation. Approved CI environment and unconditional command sequences are
checked as structures, not shell-pattern safety claims. An intended topology
change requires independent review and a corresponding trusted policy update.
Push coverage includes main, work/**, chore/**, feat/** and fix/**; all PRs to main
retain checks. Issue #69 work continues to use work/ or chore/ branches.

`Process Policy` is a separate pull_request_target check. It executes the checker,
policy, exact parser and frozen lock from the event's immutable main base. It
never checks out or executes candidate code, installs candidate dependencies,
uses candidate actions/artifacts, or follows evidence URLs. Manual dispatch takes
only a PR number and checks current state; its job permits main dispatch only and
its checkout fallback is explicitly refs/heads/main, never the selected branch.
A stale dispatch SHA or changed base fails closed and requires a fresh run.
Installation uses --ignore-scripts; checkout never persists credentials.
Only contents, issues and pull-requests read permissions are granted. There are no
repository/environment secrets. The platform-provided GitHub read token is a
credential, restricted to the fetching step; it is not inherited by parser children.

REST routes use fixed repository identity and validated IDs/SHAs. All file-list
pages are retrieved; disagreement with changed_files, duplicates, API errors or
the 3000-file API ceiling fail closed. Both rename paths require ownership.
Candidate workflows are fetched as bounded blobs, never through download URLs.
Only same-repository PRs are supported; fork heads fail closed.

The checker does not establish that a feature works from a PASS string or that
arbitrary shell code is harmless. Evidence authenticity and script indirection
remain independent-review responsibilities. Unsupported constructs are rejected.

## Evidence and independent authorization

PR metadata must contain one reelforge-process-v1 JSON record, following the PR
template. Each requiredEvidence ID in trusted policy needs an actual command,
PASS/BLOCKED/DEFERRED result and evidence location. Three complete run results
are required for each infrastructure test mode; all failures and skips must be
reported. Deferred acceptance requires an independent exact-record exception.
Only IMPLEMENTED_PENDING_REVIEW is accepted; this checker never grants approval.

Minu, account ID 353068839, independently records an authorization comment on the
linked open task issue. The implementer account cannot authorize itself. The
comment must contain exactly one JSON record of this form (example placeholders
are not valid authorizations):

```json
{
  "kind": "reelforge-authorization-v1",
  "decision": "APPROVE",
  "repositoryId": 1446655770,
  "issue": 69,
  "pr": 0,
  "base": "<exact base SHA>",
  "head": "<exact head SHA>",
  "workstream": "F",
  "metadataDigest": "<SHA256 of JSON.stringify(parsed PR metadata)>",
  "expires": "<explicit ISO timestamp with timezone>",
  "paths": ["<every exact changed path, including rename origins>"],
  "blobs": { "<each protected path>": "<Git blob SHA>" },
  "adr": ["<applicable independent decision references>"],
  "exceptions": [
    { "rule": "browser", "reason": "<explicit accepted disposition>" }
  ]
}
```

Use null as the blob value for an explicitly authorized removal or renamed-away
origin. The exact base binds the preceding content. .github changes require F.
Protected package changes also require ADR references. Trusted identities and
protected-prefix rules cannot be changed by candidate self-authorization; policy
is read from base. An authorization comment ID or author-supplied login alone is
insufficient. The real GitHub author ID/type, issue association, record contents,
paths, blobs, expiry and SHAs are checked. The authorization also binds
SHA256(JSON.stringify(parsed PR metadata)), including acceptance rows and the
authorization comment ID. An author changing evidence, scope or even parsed key
order must obtain renewed attestation. The reviewer can first create a pending
comment to allocate its ID, then replace it with the final bound approval.

Any new commit invalidates head-bound authorization. Edited/deleted records,
closed tasks, missing or inaccessible evidence and metadata ambiguity fail closed.
The report includes exact base/head, policy digest, approval body digest/update
time and changed blobs. Successful evaluation re-fetches PR and approval before
completion to detect changes. Comment changes need a manual rerun; they do not
implicitly refresh a previous check.

## Parser safety

The sole added dependency is exact yaml@2.9.1. Its expected registry SRI is:

```text
sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==
```

Input is limited to 262144 UTF-8 bytes. Each parser runs in a fresh Node child with
64 MiB V8 old-space, 512 KiB stack and a 3000ms wall limit. These are heap/stack
limits, not a claim that total OS RSS is 64 MiB. Output is bounded and children are
killed on timeout/overflow. Tokens/flow nesting and indentation are bounded before
AST construction; iterative AST checks cap 20000 nodes and depth 40 before toJS.
Duplicate keys, diagnostics, aliases, anchors, explicit tags, merge keys, complex
keys, multiple documents and unsupported AST nodes fail. Workflow checks reject
write permissions, omitted explicit read defaults, unapproved actions/runners,
credential persistence and privileged constructs. Target-workflow commands and
base checkout ref are explicitly constrained. Static command-pattern scanning is
supplemental; it is not a sandbox or complete shell analysis.

## Secret scan and audit

Secret scanning has a dedicated mandatory job. The existing scanner remains
unchanged; its pattern coverage is limited and independent review remains needed.

The dependency audit is a separate reporting job excluded from Required CI.
CLEAN requires valid zero counts and a consistent successful exit. FINDINGS
retains advisory details, severity counts and original exit; findings remain
report-only under ADR-019. Audit timeout, execution/network failure, malformed,
missing or contradictory output is UNAVAILABLE/ERROR and visibly fails the
reporting job. An initial UNAVAILABLE report prevents a failed run being mistaken
for CLEAN. Missing/upload-failed artifacts also fail the reporting job. An
unavailable audit or vulnerability finding still needs manual risk disposition;
report-only does not mean accepted risk. Repository-wide dev-dependency findings
must be recorded separately from the production audit.

## Bootstrap and immediate integration procedure

The first F PR cannot be validated by a checker already on main. Independently
review every workflow, policy and dependency change. Run local positive/negative
fixtures and mandatory CI, record missing hosted bootstrap evidence explicitly,
and obtain formal minu-the-reviewer APPROVE on the exact current head. The
Manager must disposition unavailable acceptance evidence before readiness.

Only the owner-authorized integrator merges. Immediately before integration:

1. Fetch current head/base and all referenced authorization comments afresh.
2. Verify real authorship, issue, current contents/digest, modification time,
   expiry, owned paths, exceptions and protected blob hashes against trusted policy.
3. Compare against the successful Process Policy report; rerun on any difference.
4. Verify formal independent Minu APPROVE on the latest head, no unresolved
   requested changes/blocking threads, and all mandatory CI on that head.
5. Confirm both Required CI and separate Process Policy (or explicitly accepted
   first-PR bootstrap evidence). No self-approval, direct main push, force push,
   merge commit or automatic bot mutation is permitted.
6. Squash only with expected-head SHA. Abort on changes; expected-head does not
   atomically bind mutable authorization records or base, so a residual race remains.
7. Verify resulting main SHA and reviewed closeout status; exercise hosted positive
   and negative policy cases after bootstrap. Never infer post-merge success.

Minu attests and reviews; Minu is not automatically the integrator. An unprotected
main branch permits writers to bypass this process. No repository setting, account
upgrade or technically enforced branch protection is claimed by this work.

## Evidence ownership and sequencing

F owns only the Manager's 12-file allowlist. No application, schema, event-contract,
PROJECT_STATE or DECISION_LOG changes are permitted. Do not add helper files or
root scripts without an amendment; parser child and audit modes live in the
approved checker file, tests/fixtures in its approved test file.

PR #68 remains held. Its WORK_LOG append is independent M26 evidence. Preserve
base history byte-for-byte, append only F's entry, inspect the current PR #68 log
diff before submission and coordinate sequential integration/rebase. Do not import,
rewrite or claim M26 evidence. A clean diff does not eliminate the need to
revalidate after another workstream integrates.
