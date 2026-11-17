# V5 media runtime

The authoritative design is issue #112 (LOCKED v2.0); scope/ownership is #124.
`MediaPipelineModule` is registered only when `pipeline.v2` is enabled. It binds
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
covering the channel's language. Aeneas is invoked locally with the actual audio
and one transcript word per line. Invalid, overlapping or mismatched timestamps
fail closed. There is no uniform-timing or network-transcription fallback.

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
