# V10 discovery and learning (#126)

The worker wakes once a minute and claims one durable scan per channel/local day.
It does not dispatch on boot. It consumes
the latest V7 Channel Brief through the existing workspace guard and uses V2's
`ProvidersRuntime` grounded `TextPort`; there is no alternate text adapter.

Runtime configuration uses the V2 provider models/keys and budget services.
`DISCOVERY_TEXT_ESTIMATE_USD` must be a positive operator-supplied per-call budget
estimate. Billed cost remains unknown unless supplied by the provider; an estimate
is never reported as actual cost. `YOUTUBE_DATA_API_KEY` optionally enables public
charts and search through the YouTube Data API. No keys are needed by tests.

Atomic durable reservations share conservative project-wide pools across all
workspaces: Gemini grounding 1,500/day and 5,000/month; YouTube search.list
100/day and a nested Scout maximum of 20/day. Daily/monthly periods use Pacific
time. Reservations are consumed before dispatch and retained after uncertain
failures. Gemini stops at the free monthly allowance. YouTube charts do not debit
the search.list bucket. Other application features must use the same search bucket
if they begin calling search.list; upload quotas are separate.

Rankings retain source URLs, six factor scores and the Brief id/version. Exact and
near duplicate topics are rejected for seven days. L1 produces drafts for manual
approval; L2/L3 automatically snapshot only the highest-ranked accepted idea.
Run creation remains the orchestrator's responsibility; this pack does not edit
its planning handlers or introduce a second VideoRun dispatch path.

Learning joins latest complete view/watch snapshots to own published Shorts and
stored idea factors through the existing publishing context API. Missing or
unjoined evidence cannot tune weights. At least three distinct Shorts are needed.
Configured scoring and format bounds are mandatory. A channel lock and unique
weekly audit allow at most one normalized transfer per UTC Monday week, with a
maximum absolute delta of 0.05 per weight. Brief versions remain immutable.
Prompt/config changes remain recommendations in the existing M15 workflow.
The existing /insights route reads tenant-scoped before/after changes and evidence.

A failed or interrupted claimed tick is not automatically retried, to avoid a
second paid dispatch when the outcome is uncertain. Inspect the M08 ledger and
DiscoveryRecord claim before operator reconciliation. Grounding URLs are validated
as HTTPS provider output; the landed V2 port does not expose grounding annotations,
so this pack does not claim an independent verification of citations. Learning
from Shorts without a publishing-context/topic join is unavailable.

Only lint, typecheck and touched-file fake tests run locally under the issue's
agent prompt. Full-suite, build, changed-code coverage, knip and DB drift belong to
CI. Documentation closeouts remain a separate PR; Minu reviews before merge.
