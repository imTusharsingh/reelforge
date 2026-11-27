# V5 media runtime

The authoritative design is issue #112 (LOCKED v2.0); scope/ownership is #124.
`MediaPipelineModule` binds
V4 planning and V5 assembly to V3's public handler registry and artifact-writer
boundary. V3 retains all transitions, SSE, emergency-stop checks, worker boot and
paid-call reservation/settlement behavior. No new HTTP request waits on media.

Video dispatch uses the landed V2 `VideoRouter`, `ProvidersRuntime.ports`,
`capabilityCatalog`, `ProviderLimiter` and `reservationCents`. Dispatch runs under
V3's existing reservation, avoiding a second reservation through the V2 HTTP
router wrapper. Provider ids come from the selected ports and persist before
submission. Stored ids choose the corresponding port on polling/resume; an
unknown stored id is rejected. Only proven pre-dispatch outages permit V3's
fallback re-estimation. Unknown submissions stop for reconciliation rather than
issuing a second paid call. Refusals never switch vendor or create an unreserved
rewrite attempt; V6 can supply a separately reserved rewrite policy.

The catalog's video rates are unchanged. The Grok per-input-image surcharge is
obtained from V2's estimator and includes references plus first/last frames.
Named overhead allowances in `media-prices.ts` come from #112's calculator:
images $0.0336, planning text $0.50 total, narration $0.00225/10 seconds and music
$0.08. Non-video receipts use conservative rounded reservations (cost basis
`RESERVATION`); no invoice amount is fabricated from missing provider usage.
The envelope accounts planning receipts once and then every keyframe, clip,
narration and music job. The manifest contains receipts, prompt snapshot/version
pins, billed/estimated seconds, minor-unit costs and checksums.

Shot jobs use delayed V3 workers for keyframes and video polling. Independent
shots can fan out; a continuity shot waits for its preceding clip and extracts
that clip's actual last frame. Explicit `extension:` JSON continuity notes can
pin a completed job from the same run; the V2 adapter enforces its duration
limits. No V1 contract is modified. Shot durations must be integer seconds for
the landed Omni adapter; unsupported agent output is rejected before image/video
spend. V4 remains the only shot/reference writer.

The stage handler may wait on persisted narration/music jobs inside the worker,
never in a browser HTTP request. Known jobs resume by polling, including after a
worker restart. A missing job id on an interrupted paid intent requires human
reconciliation. The output is real 720p video normalized to 1080x1920/24 fps
H.264/AAC, with cuts/crossfades, native ambience at -18 dB, a ducked instrumental
music bed, -14 LUFS normalization, captions inside the safe zone and a cover.

## Local alignment deployment

Install **aeneas==1.7.3.0**, local eSpeak language data and FFmpeg/FFprobe. The
alignment Python interpreter is selected by `ALIGNMENT_PYTHON_PATH` (default
`python3`); `FFMPEG_PATH`/`FFPROBE_PATH` select local media binaries. Install fonts
covering the channel's language. Put `espeak` and its language data on PATH.
The API and worker preflight the configured Python/aeneas, eSpeak (including
reference speech synthesis), FFmpeg with libass, and FFprobe before starting the
HTTP listener or consuming jobs. Before each new reservation and dispatch, a
targeted local probe rechecks the current FFmpeg/FFprobe, Aeneas and the pinned
eSpeak voice outside the ledger transaction. The locked admission verifies a
short-lived result for the same language and runtime configuration. Restart the
affected process after a media configuration change. Startup also reads the
installed Aeneas language catalogue and probes
the matching local eSpeak voices once in bounded batches. New VideoRuns reject an
unsupported narration language before creation. Paid admission for an existing
VideoRun checks its pinned narration language again, without blocking collection
or reconciliation of already-submitted work. Language names such as English and
Italian, supported short aliases such as en and it, and available ISO 639-3 codes
use the same resolver as rendering. Preflight is entirely local and uses no
provider credentials.

ReelForge aligns to the paced narration before
adding the final mix's silence. Aeneas analyzes both the narration and eSpeak
reference at 22,050 Hz. A separate phrase alignment controls how long the whole
caption is displayed. Each unrepaired, usable word timing retains at least one
visible frame of highlight within its phrase. Unmeasured words remain readable
without a guessed highlight. If a punctuation split cannot fit, adjacent fragments
may merge if they remain readable; incompatible measured words fail closed. The evidence gate counts usable word timings before any
neighbor repair, then the media renderer keeps the complete word timeline for
assembly evidence.

Each visible phrase stays on screen for at least 20 frames at 24 fps and targets
no more than 20 characters per second. Cue boundaries can adjust within 0.6
seconds of the measured phrase windows without overlapping or extending into
the mix's padded tail. Timing that cannot meet these limits fails closed. There
is no uniform-timing or network-transcription fallback.

To verify the complete offline caption render at two narration speeds, including
visible pixels for the active word and the cleared caption region after
narration, configure the local aligner and media binaries, then run:

```bash
RF_ALIGNMENT_RENDER_TEST=1 pnpm exec vitest run apps/api/src/modules/composition/media-caption-render.local.test.ts
```

Legacy synchronous POST generation/retry/regenerate/replace endpoints and their
still-image production/dispatch ledger are removed. History/export readers and
C3 asset assignment remain deprecated until T2; no table or column is dropped.
The OpenAI-named Gemini aliases are removed, together with their legacy consumer
bindings. All test transports and media fixtures are explicitly test-only; no
provider key is required or used in verification. The first live run belongs to
T1 and requires Tushar's authorization.

V6's critic is intentionally not fabricated: after V5 assembly V3 advances to
CRITIC, where the V6 handler must be registered before automated review proceeds.
The produced final and manifest are already on the persisted assembly step.

Reservation preflight is part of the durable media attempt. A typed budget denial
with no matching reservation/request closes the attempt and refunds its envelope
in one transaction. After a confirmed fresh reservation, an emergency boundary
failure settles known non-dispatch before closing/refunding the attempt. A
timeout, partial ledger write, replay, or failed settlement retains held budget;
retries inspect the M18 idempotency key and request correlation and require human
reconciliation without resubmitting or assuming a refund. Replayed intent claims
are rejected so concurrent workers cannot share preflight ownership.

## Text receipt recovery

Drain existing workers before enabling workers that write the new planning receipts.
Readers on this revision still accept old receipts. New text receipts keep the local
`dispatchKey` separate from `providerJobId`, which is null when Google returned no ID.
New assembly exports also normalize historical text receipts without changing the
stored records. Media jobs such as video shots still require their provider job ID.

The text lock uses the `sync-text-advisory-v2` protocol. The orphan sweep releases
a stranded preparation without committing spend. An armed attempt may have sent
its POST; it becomes confirmable after the session lock is lost, with no second
POST. A definitive provider rejection releases an uncommitted reservation or
corrects an already-committed owner estimate to zero, with an audit event.
Before rollouts, inventory older and unversioned dispatch markers before and after
draining workers. The new sweep leaves them untouched for evidence-led reconciliation.

An authenticated workspace owner can attach evidence from a recovered Google receipt
with `POST /api/v1/runs/:runId/steps/:stepId/text-evidence?workspaceId=…`.
Send the original `dispatchKey`, recovered `providerJobId`, optional integer
`usage` counters, and `confirmedOriginalAttempt: true`. This records
owner-reported evidence, the submitted counters, and the actor on that attempt.
New counters can be added; a retry cannot overwrite a stored counter.
The endpoint does not contact Google,
replace the generated output, treat reported usage as verified cost, or settle
the reservation. Terminal confirmation remains a separate operation.

## Local aeneas installation

On Debian-based hosts, install eSpeak and its development library alongside Python 3.10 with venv support. Use the same interpreter for API and worker preflight.

```sh
sudo apt install espeak libespeak-dev
python3.10 -m venv ~/reelforge-alignment
~/reelforge-alignment/bin/pip install numpy==1.26.4 setuptools==59.8.0 wheel
AENEAS_WITH_CEW=False ~/reelforge-alignment/bin/pip install --no-build-isolation aeneas==1.7.3.0
export ALIGNMENT_PYTHON_PATH="$HOME/reelforge-alignment/bin/python"
export PYTHONIOENCODING=UTF-8
```
