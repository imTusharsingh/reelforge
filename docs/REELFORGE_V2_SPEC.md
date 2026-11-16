# ReelForge v2 spec — LOCKED v2.0 (2026-11-16)

**Canonical locked spec:** [GitHub issue #112](https://github.com/imTusharsingh/reelforge/issues/112). This file is a versioned copy of that locked export so coding agents can read it in the repo. If this file and #112 disagree, #112 wins.

**Source of truth for coding agents.** This is a faithful markdown export of the locked Cursor Page "ReelForge v2: autonomous AI Shorts pipeline" (https://cursor.com/canvas/store-5da7ba8a-40f3-47f7-86ed-5695e5f3e1a3/04a6440b-ca67-40a2-8346-828f221fa8f0), which coding agents can't open. Interactive widgets are expanded (all autonomy levels, all 12 requirements, every calculator input). Section A below collects the exact enums and field lists the V1 shared contracts must provide; it is derived only from the Page and the V2–V10 requirements and adds no new decisions. Section B is the Page export itself. If A and B ever disagree, B (the Page) wins.

## A. V1 contract checklist (exact enums and fields)

All money in integer minor units (USD cents) unless stated; per-second prices need sub-cent precision (micro-USD integers or decimal strings). Every persisted entity carries `id`, `workspaceId`, `schemaVersion` and goes through the ADR-003 workspace guard.

### A1. VideoRun state (Page "Mermaid sources" + V3)
- States: `PLANNING, SCRIPTING, SHOT_PLANNING, GENERATING, ASSEMBLING, CRITIC, AWAITING_APPROVAL, SCHEDULED, PUBLISHED, LEARNING, PAUSED_BUDGET, NEEDS_HUMAN, FAILED, CANCELED`.
- Transitions: `[*]→PLANNING→SCRIPTING→SHOT_PLANNING→GENERATING→ASSEMBLING→CRITIC→AWAITING_APPROVAL→SCHEDULED→PUBLISHED→LEARNING→[*]`; `CRITIC→GENERATING` (reshoot failing shots); `GENERATING→PAUSED_BUDGET→GENERATING`; `CRITIC→NEEDS_HUMAN→GENERATING`; `PLANNING→CANCELED`; `GENERATING→FAILED`. Every transition is a server-side guarded update (ADR-006); LLMs never choose transitions. The ADR-019 emergency stop applies to every VideoRun at paid dispatch and step boundaries.
- VideoRun row (Page Architecture): state, requested + effective autonomy, budget envelope, brief snapshot id/version, correlation id, idempotency key.
- VideoRunStep row: step key, attempt, idempotency key, provider id, provider job id, cost, artifacts, input/output/error, timestamps. Step-level attempt states are separate from run states.
- RunEvent: run id, optional step id, monotonically increasing sequence per run, type, correlation id, occurredAt, payload. Published to Redis pub/sub; SSE at `/api/v1/runs/:id/events` (V3).

### A2. Autonomy (Page "Autonomy levels", V8, decisions)
- Levels `L1` (approve each stage), `L2` (approve before publish; default), `L3` (full auto).
- First-ten rule: during a channel's first **10 approved** Shorts, L3 is unavailable (a requested L3 runs as L2); L1 and L2 are honored. After 10 approved Shorts the app offers L3 with the critic-agreement score (recommended at 8 of 10 or better); explicit opt-in. An L3 run that fails a gate falls back to L2 and lands in the inbox. Script wait only at L1. Hard gates (policy, rights, technical, budget) are never skipped.
- Count approvals per channel (store e.g. `approvedShortsAtStart`), not published uploads or workspace totals.

### A3. ChannelBrief (Page "Set up once", M02, V7, V4, V10)
Niche/topic, audience, style bible (visual style, palette, recurring character(s) or none, banned visuals), narrator voice (provider, voice id, pace; optional on-camera character voice), language (script, narration, captions; default English), cadence (shorts/day, local time, channel timezone; default 1/day 18:00), budget policy ($6 target, $8 hard cap per Short, $20/day, $180/month), requested autonomy, guardrails (topics to avoid / banned topics, no real people or brands, no AI persona giving health, legal, finance or political advice, fact-check strictness, AI disclosure always on), format mix over the 8 format templates with tuning bounds (V10 auto-tunes format mix and scoring weights within bounds; missing bounds = recommendations only), render profile, reference pins/defaults. Versioned and immutable per version.

### A4. ShotSpec (Page "Plan shots", M07, V4, V5)
Run id, ordinal, version, duration (shots about 6–8 s, 3–10 s range; durations sum to target within 1 s), subject refs (pinned reference id + version, at most 6 per Omni call: character first, then scenery, then style), camera, keyframe prompt, motion prompt, VO line, on-screen text, continuity notes, first/last-frame chaining (last frame of shot n may be the first frame of shot n+1), transition, 9:16 dimensions, fps, optional seed.

### A5. ProviderCapability (Page `VideoGenPort.capabilities()`, V2)
Provider id, model id (in config, not code), kind `TEXT | IMAGE | VIDEO | TTS | MUSIC` (critic uses multimodal TEXT), min/max seconds, aspects, reference-image count (Omni 6, Grok Imagine 1.5 14), first/last frame, extension (Omni 3–10 s per turn, 30 s total), native audio, async/polling, frame rates, `pricePerSecond` per resolution `360p | 720p | 1080p` (nullable), health. Omni 720p = $0.0695/s; Grok Imagine 1.5 720p = $0.14/s.

### A6. BudgetEnvelope (Page "Cost control", V3)
Run id, currency USD, target ($6), hard cap ($8), base estimate (computed from the shot list before the first media call; refuse if above $8), reshoot reserve (50% of clip cost), reserved, spent, route (primary/fallback; on fallback re-estimate remaining shots at fallback rates and drop the reshoot reserve if needed), revision. Envelope = base estimate + reshoot reserve, hard-capped at $8; warn above $6; PAUSED_BUDGET or NEEDS_HUMAN when exceeded; honors M18 daily/monthly caps and the M19 emergency stop.

### A7. ReferenceAsset + ChannelReferenceDefaults (V1, V4, Future upgrades)
ReferenceAsset: stable reference id, kind `CHARACTER | STYLE | SCENERY | PROP`, source `SYSTEM | PRESET | UPLOADED | USER_GENERATED`, immutable versions pinned to M04 asset/character versions (ADR-016), rights/provenance, checksum, metadata (ref images, voice id, style notes). ChannelReferenceDefaults: per-channel default character/style/scenery/prop pins. U1 presets and U2 uploads/generation only add sources and UI.

### A8. Seeded defaults (Page "Zero-config defaults")
Prompt pack v1 for every agent: **Trend Scout, Idea Scorer, Scriptwriter, Director, Art Director, Critic, Packager** (seven roles, Page "Agent roles"). 8 formats: explainer, top-3, story, myth vs fact, what-if, history moment, quick how-to, news recap. Render 1080×1920, 24 fps, H.264. Budget $6/$8/$20 per day/$180 per month. L2; 1 Short/day at 18:00 channel timezone; English narration; AI disclosure on. Idempotent, no network.

---

## B. Page export (verbatim content)


> Why v1 turned into a manual slideshow tool, and a concrete plan to make ReelForge a mostly AI-run pipeline that makes real AI video Shorts for YouTube: vendor research, architecture, cost per short, module map and roadmap.

**Contents:** Recommendation · Diagnosis: why v1 became manual and slideshow-like · Product vision v2 · Architecture · Video vendor research · Video generation strategy and cost · Module map M00–M34 · Zero-config defaults · Roadmap: 12 requirements · Code quality and cleanup · Future upgrades · Risks and decisions (decided 2026-11-16) · Changelog (lock audit) · Sources

> **LOCKED v2.0 — 2026-11-16** _(success)_: Final audit done: vendor facts re-verified on official pages, Page, requirement drafts and the V1 prompt brought into line, and the owner's decisions unchanged. Changes are listed in the Changelog at the end.

## Recommendation

- **Primary video model:** Gemini Omni 1.2 Flash — Google Gemini API, 9:16, 3–15 s clips, native audio, 6 reference images
- **Fallback video model:** Grok Imagine 1.5 — xAI, 9:16, 1–15 s, 14 refs, pinned frames
- **Estimated cost per 45 s short:** $5.79 — 720p clips upscaled, 1.5x retry allowance; re-verified 2026-11-16
- **Orchestrator:** BullMQ + Postgres — Keep the stack; durable VideoRun state machine

> **The short version**: Rebuild ReelForge around one object, the VideoRun: a durable per-video state machine that runs on its own from a one-time Channel Brief. Swap still images for real image-to-video clips from Gemini Omni Flash, with keyframes and character references for consistency. Add an AI critic that reshoots weak shots, and leave the human one optional tap before publish. About 70% of v1 is reusable: auth, ledger, budgets, FFmpeg render, publishing, analytics and orchestration all stay. What changes is the product flow and the media path.

## Diagnosis: why v1 became manual and slideshow-like

| Symptom | Root cause | Where in the repo |
| --- | --- | --- |
| The user has to pick everything | Each module was built with its own screen and approval, so the UI became the workflow. The generation workflow exists in M16 but the product walks you through module screens. | M23–M27 screens; M16 GENERATION definition |
| The pipeline stops for a human mid-run | By design: the script step waits up to 72 h for human approval, manual review is the default, and learning cannot change anything without approval. | ADR-005, ADR-009, ADR-017 #2 |
| Output is stills plus TTS | OpenAI was the only provider. Its Videos API and sora-2 shut down on 2026-09-24, so video stays NotConfigured and M09 falls back to 1024×1536 PNG images. | ADR-025; M09; packages/ai-providers |
| A fresh workspace can't generate a script | Nothing seeds prompt snapshots, provider budget or genre, and there's no UI for them. | M05, M18, M03; no seed defaults |
| MISSING_VOICE on narration | Voice belongs to a per-scene character, so a narrator-only script has no voice. | M07 script schema, M09 voice step |
| Render rejects real images | M10 validates exact 1080×1920 stills instead of normalising them. | validateSourceImageDimensions in composition.engine.ts |
| Blank hook/CTA wastes a paid call | The prompt and schema allow empty strings. | M07 validation |
| 'Response interrupted' in the browser | Scene generation runs inside one long HTTP request instead of async jobs. | scene-media.controller.ts |
| Policy risk even if it worked | YouTube's inauthentic content policy names 'image slideshows' and 'AI-generated content made with generic or unoriginal templates' as not monetisable. | Product design, not code |

The engineering foundations are good (idempotent ledger, budget reservation, deterministic state machines, FFmpeg with pinned inputs). The problem is the product shape, plus a media path that had no working video provider.

## Product vision v2

### Set up once: the Channel Brief

- **Niche and audience:** e.g. 'science explainers for 16–25 year olds, India + US'
- **Style bible:** Visual style, palette, recurring character(s) or none, banned visuals
- **Voice:** Narrator voice, pace; optional on-camera character voice
- **Language:** Script, narration and captions (default English; Omni is only fully evaluated in English)
- **Cadence:** e.g. 1 Short/day at 18:00 channel timezone
- **Budget:** $6 target and $8 hard cap per Short; $20/day and $180/month defaults
- **Autonomy:** L1, L2 (default) or L3
- **Guardrails:** Topics to avoid, no real people or brands, no AI persona giving health, legal, finance or political advice, fact-check strictness, AI disclosure always on

### What the AI then does for every Short

1. **Discover** — Trend Scout pulls topics from Gemini with Google Search grounding, YouTube Data API charts and the channel's own analytics.
2. **Score** — Idea Scorer ranks novelty against channel history, trend velocity, brief fit, predicted retention, cost feasibility and policy risk.
3. **Write** — Scriptwriter returns strict JSON: a hook of 3 s or less, 3–5 beats, payoff and CTA. Empty or over-length fields are rejected before any media spend.
4. **Plan shots** — Director turns the script into about 6 shots of 6–8 s: subject refs, camera, keyframe prompt, motion prompt, VO line, on-screen text.
5. **Generate** — Art Director keeps character and style reference images. A keyframe is made per shot, then each shot becomes a real clip with image-to-video, all in parallel.
6. **Voice, music, captions** — One channel narrator over the whole cut, a Lyria music bed, and word-timed captions from forced alignment.
7. **Edit** — FFmpeg (M10) assembles: normalise to 1080×1920, cuts and transitions, ducking, captions, -14 LUFS loudness, cover frames.
8. **Critique** — A multimodal AI critic watches the cut and scores hook, coherence, artifacts, caption sync, brief fit and policy. Failing shots are reshot within budget.
9. **Approve (optional)** — Depends on the autonomy level: one tap on the phone, or none.
10. **Publish and learn** — Auto-slotted YouTube Shorts upload with containsSyntheticMedia set. Analytics feed back into the scoring weights for the next ideas.

### Autonomy levels

| Decision | L1 Approve each stage | L2 Approve before publish (default) | L3 Full auto |
| --- | --- | --- | --- |
| Idea picked | Human taps 1 of 3 | AI (top score) | AI (top score) |
| Script + shot list | Human approves or edits | AI + schema gates | AI + schema gates |
| Clip reshoots | AI within budget | AI within budget | AI within budget |
| Final video | Human approves | Human single tap | AI critic score + hard gates |
| Publish slot | Human confirms | Auto-slotted by cadence | Auto-slotted by cadence |
| Over-budget or failed gate | Ask human | Ask human | Fall back to L2 for this video |

Recommended default: L2 for a channel's first 10 Shorts, then the app offers L3 and shows how often the critic agreed with your taps (recommended at 8 of 10 or better). Hard gates (policy, rights, technical, budget) can never be skipped at any level.

## Architecture

### Pipeline (one VideoRun)

**Diagram (vertical):**

Nodes: Channel Brief; Trend Scout; Idea Scorer; Scriptwriter (hook, beats, CTA); Director (shot list); Art Director (refs + keyframes); Clip generation (image-to-video, parallel); Narration + music; Editor (M10) (FFmpeg assembly); AI critic + hard gates; Packaging; Autonomy policy; One-tap approval; Schedule + publish; Analytics → learning

Edges:
- Channel Brief → Trend Scout
- Trend Scout → Idea Scorer
- Idea Scorer → Scriptwriter
- Scriptwriter → Director
- Scriptwriter → Narration + music
- Director → Art Director
- Art Director → Clip generation
- Clip generation → Editor (M10)
- Narration + music → Editor (M10)
- Editor (M10) → AI critic + hard gates
- AI critic + hard gates → Clip generation [reshoot weak shots]
- AI critic + hard gates → Packaging [pass]
- Packaging → Autonomy policy
- Autonomy policy → One-tap approval [L1/L2]
- Autonomy policy → Schedule + publish [L3 + score ok]
- One-tap approval → Schedule + publish
- Schedule + publish → Analytics → learning
- Analytics → learning → Idea Scorer [weights]

### Orchestrator: BullMQ flows + Postgres state machine (not Temporal)

**Why BullMQ + Postgres VideoRun**

- Already pinned (BullMQ 6.6, ioredis) and integrated in M16, with tests and reviewer familiarity
- Volume is small: tens of runs a day, about 10–20 paid calls per run
- FlowProducer gives fan-out/fan-in: one parent assemble job, one child job per shot
- Human waits are just persisted states, not sleeping workflows
- No new server to host before launch (#91)

**What we give up versus Temporal**

- We hand-write durability: step rows, idempotency keys, resume-on-boot
- No built-in workflow replay or history UI, so we build a Run Timeline
- Compensation logic (refund envelope, cancel provider job) is ours to test
- Revisit Temporal past about 500 runs/day, multi-region workers, or complex sagas

- VideoRun row: state, autonomy, budget envelope, brief snapshot id, correlation id. VideoRunStep rows: step key, attempt, idempotency key, provider job id, cost, artifacts.
- Every transition is a server-side guarded update (keep the ADR-006 rule: LLM agents return structured outputs and never choose transitions).
- Provider jobs: submit, store the job id, then poll with delayed BullMQ jobs every 10–15 s (or a webhook where offered). No HTTP request waits on media.
- On worker boot, sweep non-terminal steps and poll stored provider job ids. Never resubmit a paid call without reconciliation (keeps the M08/M18 m08:<correlationId> rule).
- Progress: the worker publishes RunEvents to Redis pub/sub; the API serves SSE at /api/v1/runs/:id/events; the web Run Timeline subscribes.

### Agent roles (all structured-output LLM calls)

| Agent | Input | Output (schema-validated) | Model |
| --- | --- | --- | --- |
| Trend Scout | Brief, grounding search, YouTube charts, own analytics | 10 candidate topics with sources | Gemini 3.8 Flash + Search grounding |
| Idea Scorer | Candidates, history embeddings, learned weights | Ranked ideas with factor scores | Gemini 3.8 Flash |
| Scriptwriter | Idea, format template, voice | Hook, beats, payoff, CTA, word count | Gemini 3.8 Flash |
| Director | Script, style bible | Shot list with durations summing to target | Gemini 3.8 Flash |
| Art Director | Brief, shot list | Reference set + keyframe prompts | Nano Banana 2.1 (images) |
| Critic | Rendered cut (frames + audio), script, brief | Rubric scores, per-shot verdicts, fix instructions | Gemini 3.8 Flash (multimodal) |
| Packager | Final cut, script | Title, description, tags, cover frame | Gemini 3.8 Flash |

### Provider abstraction, routing and fallback

```
interface VideoGenPort {
  capabilities(): { maxSeconds: number; minSeconds: number; aspects: string[];
                    refImages: number; firstLastFrame: boolean; nativeAudio: boolean;
                    pricePerSecond: Record<"360p"|"720p"|"1080p", number | null> };
  estimate(spec: ShotSpec): Money;                 // before any spend
  submit(spec: ShotSpec, idemKey: string): Promise<{ providerJobId: string }>;
  poll(providerJobId: string): Promise<"queued"|"running"|"succeeded"|"refused"|"failed">;
  fetch(providerJobId: string): Promise<ClipArtifact>; // stored, probed, checksummed
}
// Router: pick by tier -> capability fit -> price -> health (circuit breaker on 5xx/timeouts).
// Content refusal: rewrite the prompt once, then mark NEEDS_HUMAN; never silently switch vendor on a refusal.
// 429 / spend-rate limit: back off through a per-provider concurrency limiter; never switch vendor.
// Provider outage: fall back to the next vendor in the channel's route list.
```

### One paid clip call

**Sequence:**

1. Orchestrator → Budget (M18): reservePaidCall(estimate, m08:<runId:shot:attempt>)
2. Budget (M18) → Orchestrator: reserved within envelope
3. Orchestrator → Router (M08): submit(shotSpec)
4. Router (M08) → Gemini Omni: image-to-video, 9:16, 8 s, refs
5. Gemini Omni → Router (M08): interaction id
6. _Note (Orchestrator): job id persisted before polling; delayed job polls every 10–15 s_
7. Router (M08) → Gemini Omni: poll / fetch
8. Router (M08) → Storage: store clip, ffprobe, sha256
9. Orchestrator → Budget (M18): finishPaidCall(actual = seconds × rate)

### Cost control, quality gates, storage, observability

#### Cost control

- Estimate the full run from the shot list before the first media call; refuse if over the per-short cap
- Envelope = base estimate + reshoot reserve (50% of clip cost), hard-capped at $8; every paid call draws from it
- On fallback, re-estimate remaining shots at fallback rates and drop the reshoot reserve if needed (a full 45 s run on Grok Imagine 1.5 is about $7.45 with no reshoots)
- M18 daily/monthly caps and the M19 emergency stop apply to every run; Gemini project spend cap set in AI Studio as a backstop
- Reshoots only while the envelope has room; otherwise NEEDS_HUMAN or PAUSED_BUDGET
- Actual cost = billed seconds × catalog rate, reconciled with provider usage

#### Quality gates

- Pre-spend: schema, non-empty hook/CTA, durations, policy screen on prompts
- Per clip: ffprobe, black/frozen-frame detect, duration, aspect
- Cut: critic rubric 0–10 per axis; pass at 7 or above with no axis under 5
- At most 2 reshoots per shot and 1 full re-edit per run

#### Storage

- Existing M04 StoragePort (local driver today; S3-compatible adapter added in T2 for hosting), content-addressed by checksum
- Artifacts: refs, keyframes, clips, narration, music, captions, final, manifest
- Drafts kept 14 days, finals and manifests kept forever
- Signed URLs for the web; no provider URLs stored

#### Observability

- Trace per run via the existing M19 tracing (OTel field names), a span per step and provider call; real exporter in T2
- Metrics: cost per short, latency and refusal rate per provider, critic pass rate
- Provider acceptance rate feeds router ordering
- Run Timeline UI shows every step, prompt version and cost

### Mermaid sources for the repo docs

```
flowchart TD
  B[Channel Brief: niche, style, voice, cadence, budget, autonomy] --> T[Trend Scout]
  T --> S[Idea Scorer]
  S --> W[Scriptwriter: hook, beats, CTA]
  W --> D[Director: shot list 6 x 6-8 s]
  D --> A[Art Director: character + style refs]
  A --> K[Keyframes: 1 image per shot]
  K --> V[Image-to-video clips, parallel]
  W --> N[Narration TTS + Lyria music]
  V --> E[Editor: FFmpeg assembly, captions, transitions]
  N --> E
  E --> C{AI critic + hard gates}
  C -- shot fails, budget left --> V
  C -- pass --> P[Packaging: title, description, tags, cover]
  P --> H{Autonomy policy}
  H -- L3 and score ok --> Q[Schedule + publish to YouTube]
  H -- L1/L2 --> U[One-tap approval]
  U --> Q
  Q --> Y[Analytics]
  Y --> L[Learning: scoring weights]
  L -.-> S
```

```
stateDiagram-v2
  [*] --> PLANNING
  PLANNING --> SCRIPTING
  SCRIPTING --> SHOT_PLANNING
  SHOT_PLANNING --> GENERATING
  GENERATING --> ASSEMBLING
  ASSEMBLING --> CRITIC
  CRITIC --> GENERATING: reshoot failing shots
  CRITIC --> AWAITING_APPROVAL
  AWAITING_APPROVAL --> SCHEDULED
  SCHEDULED --> PUBLISHED
  PUBLISHED --> LEARNING
  LEARNING --> [*]
  GENERATING --> PAUSED_BUDGET
  CRITIC --> NEEDS_HUMAN
  PAUSED_BUDGET --> GENERATING
  NEEDS_HUMAN --> GENERATING
  PLANNING --> CANCELED
  GENERATING --> FAILED
```

## Video vendor research (re-verified 2026-11-16)

| Vendor / model | Clip length | Resolution, 9:16 | Native audio | Price per second | Rate limits | Maturity | Policy and terms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Google Gemini API: gemini-omni-1.2-flash | 3–15 s; extend 3–10 s per turn to 30 s; first+last frame 3–10 s | 360p, 720p native; 1080p and 4K upscaled; 24 fps; 9:16 or 16:9; English fully evaluated, other languages not | Yes | 720p $0.07; 1080p $0.104; 360p $0.023 (token-billed, Google's stated equivalents) | Tier 1: 8 RPM, 40 RPD; Tier 2: 16/200; Tier 3: 40/2,000; no free tier; Tier 1 also limits spend to $10 per 10 min and $250/month; RPD resets midnight PT; refs/keyframe input billed at $1.50 per 1M tokens | GA on paid tier; released 2026-11-05 | Prompt and output safety filters; SynthID watermark; recognizable-people uploads unsupported; Google claims no ownership of output |
| Google Vertex: Veo 3.1 / Fast / Lite | 4, 6 or 8 s | 720p, 1080p, 4K; 9:16 yes | Yes | Veo 3.1 $0.40; Fast $0.10 (720p); Lite $0.05 (720p) (not re-checked) | Not checked | GA on Vertex; Gemini API previews shut 2026-10-22 | Google Cloud terms (not reviewed) |
| xAI: grok-imagine-video-1.5 | 1–15 s | 480p, 720p, 1080p native; 9:16 yes | Yes, lip-synced speech, 3 voice refs | 720p $0.14; 1080p $0.25; +$0.01 per input image | Video: 10 RPS at Tier 0, 20 at Tier 1 ($50 spend); prepaid credits | GA; docs updated 2026-11-13 | xAI AUP; enterprise terms give the customer ownership of output |
| xAI: grok-imagine-video-1.5-lite | 1–15 s | Up to 1080p (upscaled from 720p); 9:16 yes | Yes | 720p $0.03; 1080p $0.14 | As above | GA | No refs or pinned frames |
| Kling direct: Kling 4.0 / 4.0 Flash | 4.0: 3–30 s; Flash: 3–20 s | 720p, 1080p; 9:16 yes | Not stated for 4.0; Kling 3.0 has an audio tier ($0.126 at 720p) | 4.0: 720p $0.157, 1080p $0.235; Flash 720p $0.094 | Concurrency slots per resource package; no QPS limit | Mature; 4.0 Flash released 2026-11-04 | Terms 6.4: commercial use of output not restricted; prepaid packages non-refundable |
| Runway Dev: Gen-4.5 (also hosts Kling, Seedance, Grok Imagine, Omni, Hailuo) | Not checked | Not checked | Not stated | Gen-4.5 $0.12; Omni 1.2 Flash 720p $0.07; Seedance 2.0 720p $0.30 (not re-checked) | Not checked | Mature aggregator | Not reviewed |
| Luma: Ray3.2 | 5 or 10 s (billed per 5 s block) | 360p–1080p; 9:16 yes | Not confirmed | 720p $0.06; 1080p $0.24 (not re-checked) | 'Rate limits apply, no latency SLA' | Rates 'subject to change ahead of GA' | Not reviewed |
| MiniMax: H3 / H3-Lite | Not checked | 480p, 768p, 2K | Not stated (audio input free) | H3 768p $0.08, 2K $0.13; Lite 768p $0.04 (not re-checked) | Not checked | Mature | Not reviewed |
| Pika: H3 Flex | 3–15 s | 480p, 768p native; upscale to 1080p+; 9:16 yes | Yes, with stems | 1080p $0.035 per a search summary; not verified on the page | Concurrency queueing | Self-serve, prepaid | Not reviewed |
| OpenAI: sora-2 / Videos API | — | — | — | Shut down 2026-09-24 | — | Dead | — |

### Voice, music, images, text, lip-sync

| Need | Option | Price | Note |
| --- | --- | --- | --- |
| Narration (default) | Gemini 3.8 Flash TTS | $0.00225 per 10 s audio until 2026-12-31; $0.0045 from 2027-01-01 | Same key as video |
| Narration (premium) | ElevenLabs TTS v4 | $0.08 per 1,000 characters (about $0.06 per 45 s Short) (not re-checked) | Custom and cloned voices by id |
| Music | Lyria 3.5 (Gemini API) | $0.08 per song | Prompt 'instrumental only'; output about 2 min, trimmed; SynthID audio watermark; safety filter blocks artist voices and copyrighted lyrics |
| Keyframes and refs | Nano Banana 2.1 | $0.0336 per 1K image | Character consistency across turns |
| Agents (text) | Gemini 3.8 Flash | $0.75 / $3.75 per 1M in/out until 2026-12-31; $1.50 / $7.50 after | Price doubles 2027-01-01; Search grounding 5,000 free/month, then $14 per 1,000, 1,500/day cap |
| Lip-sync (avatar format only) | sync.so sync-3 | $0.133 per second (not re-checked) | Not needed by default: Omni and Grok Imagine make speech natively |
| Retire | gpt-4.1-mini, gpt-4o-mini-tts | EOL 2027-01-14 and 2027-01-06 | Keep OpenAI only as text fallback on a current model |

### YouTube constraints that shape the design

- Uploads: videos.insert and search.list each have their own default bucket of 100 calls/day (10,000 units for everything else); quotas reset at midnight PT.
- Scheduling: upload as private with status.publishAt and YouTube publishes at the slot. Uploads from unverified API projects are not restricted to private.
- Set status.containsSyntheticMedia=true on upload for realistic AI content.
- Monetisation: the inauthentic content policy (renamed 2025-07-15) excludes image slideshows and template-made AI content without original insight, so v2 needs per-video variety, a real angle and narrative, not just better pixels.
- The same policy says AI personas giving health, legal, finance or political advice can't be monetised, and neither can stitched, unrelated AI clips with no narrative arc.
- Disclosure is required for realistic AI video and for AI music that is the main focus; disclosing alone doesn't limit reach or monetisation.

## Video generation strategy and cost

### How clips become one coherent 30–60 s Short

1. **Style lock per channel** — Art Director makes a reference set once (character front, side and full body, plus a style frame) and reuses it as Omni reference images (up to 6).
2. **Keyframe per shot** — A 9:16 first-frame image per shot with the same refs, so composition is controlled before paying for motion.
3. **Image-to-video per shot** — 6–8 s clips; first+last frame for continuity shots (3–10 s limit); prompt says 'single continuous shot' and 'no dialogue' when narration covers it.
4. **Continuity tricks** — Use the last frame of shot n as the first frame of shot n+1 for match cuts. Use Omni extension (3–10 s per turn, 30 s total) for one long take.
5. **Audio stack** — Native clip audio kept as ambience at -18 dB, one narrator track on top, Lyria bed ducked under the voice, SFX optional.
6. **Edit** — Scale/crop every clip to 1080×1920 (lanczos), 6–10 frame crossfades or hard cuts on beats, word-level captions in the safe zone, -14 LUFS, 24 fps H.264 (Omni's native rate).
7. **Critic loop** — Score the cut, then reshoot only the failing shots, at most twice each, within the envelope.

### Cost per Short calculator

Calculator inputs (interactive on the Page). Default shown: Gemini Omni 1.2 Flash 720p, 45 s, 1.5× retry.

| Video model | Price per second (USD) | Extra per clip (USD) |
| --- | --- | --- |
| Gemini Omni 1.2 Flash, 720p (recommended) | 0.069504 | 0 |
| Gemini Omni 1.2 Flash, 1080p upscaled | 0.104 | 0 |
| xAI grok-imagine-video-1.5, 720p (fallback) | 0.14 | 0.01 |
| xAI grok-imagine-video-1.5-lite, 720p | 0.03 | 0.01 |
| Kling 4.0, 720p | 0.157 | 0 |
| Kling 4.0 Flash, 720p | 0.094 | 0 |
| Runway Gen-4.5 | 0.12 | 0 |
| Veo 3.1 Fast on Vertex, 720p | 0.1 | 0 |
| Veo 3.1 on Vertex, 1080p | 0.4 | 0 |

Length options: 30 s / 45 s / 60 s. Retry allowance options: 1.0× (no reshoots) / 1.3× / 1.5× (planning default) / 2.0× (worst case). Shots = ceil(seconds / 7.5).

- **Estimated cost per Short:** $5.79
- **Video clips:** $4.69 — 6 shots
- **Everything else:** $1.09 — agents, keyframes, TTS, music
- **Per month at 1 Short/day:** $174

`cost = seconds × price/s × retry + (3 + 2 × shots) × $0.0336 + $0.50 + (seconds / 10) × $0.00225 + $0.08`

Worked default (re-verified 2026-11-16): Omni 720p is 5,792 output tokens/s × $12 per 1M = $0.0695/s, so 45 s × $0.0695 × 1.5 = $4.69 for clips; 15 keyframe images × $0.0336 = $0.50; agents and reference-image input budgeted at $0.50; narration $0.01; music $0.08. Total $5.79, about $174 a month at 1 Short/day. From 2027-01-01 Gemini TTS and 3.8 Flash text double; that adds about $0.01 here and stays inside the $0.50 agent allowance. Worst case at 2.0× retries is $7.35. A full fallback run on Grok Imagine 1.5 is about $7.45 with no reshoots, so fallback runs drop the reshoot reserve. The $0.50 for agents and the 1.5× retry allowance are estimates, not vendor figures.

### Clip cost for a 45 s Short by model

- Gemini Omni 1.2 Flash 720p: $4.69
- xAI Grok Imagine 1.5-lite 720p: $2.03
- Luma Ray3.2 720p: $4.05
- MiniMax H3 768p: $5.40
- Kling 4.0 Flash 720p: $6.35
- Veo 3.1 Fast (Vertex) 720p: $6.75
- Gemini Omni 1.2 Flash 1080p: $7.02
- Runway Gen-4.5: $8.10
- xAI Grok Imagine 1.5 720p: $9.45
- Kling 4.0 720p: $10.60
- Veo 3.1 (Vertex) 1080p: $27.00

Price isn't quality. Right after V2, T1 renders the same 3-shot test on Omni, Grok Imagine 1.5 and Kling 4.0 Flash (about $10 total) so you can judge side by side.

### Why Gemini Omni as primary and Grok Imagine 1.5 as fallback

**Pros**

- One Google key covers agents, keyframes, video, TTS and music, so a fresh install needs one secret
- 9:16, 3–15 s, 6 reference images, first/last frame, extension to 30 s, native audio
- Cheapest full-featured 720p rate ($0.07/s) among GA options found
- Grok Imagine 1.5 matches the features (14 refs, pinned frames, 15 s, native lip-sync) on separate infrastructure, so an outage on one doesn't stop runs

**Cons**

- Omni 1.2 is 11 days old; Google shut the Veo previews after about a year
- Tier 1 is 40 requests/day (about 4 Shorts/day with reshoots), $10 per 10 min and $250/month; Tier 2 ($100 paid + 3 days) needed before T1 plus daily runs
- Fallback costs 2× per second at 720p, so fallback runs drop the reshoot reserve to stay under $8
- Neither has been tested by us for quality yet

## Module map M00–M34

_Options: All (35) / Keep (16) / Rework (15) / Promote (1) / Drop/Defer (3) — shown: All_

| Module | Name | Verdict | What changes | Requirement |
| --- | --- | --- | --- | --- |
| M00 | Governance & contracts | **[Keep]** | Add VideoRun, Shot, ProviderCapability and RunEvent contracts. | V1 |
| M01 | Identity & workspace | **[Keep]** | Unchanged. | Unchanged (T2 regression) |
| M02 | Channel & brand | **[Rework]** | Becomes the one-time Channel Brief: niche, audience, style bible, voice, cadence, budget, autonomy, guardrails. | V7 |
| M03 | Genres, formats & series | **[Rework]** | Ship 8 built-in format templates; genre is no longer a required user choice. | V1, V7 |
| M04 | Characters & assets | **[Rework]** | Character = reference images + voice id + style notes, created by the Art Director agent and passed as video reference images. | V4 |
| M05 | Config & prompt engine | **[Keep]** | Keep layered snapshots; add a code-shipped default prompt pack seeded idempotently (no network). | V1, V4 |
| M06 | Ideas & topics | **[Rework]** | Trend Scout + Idea Scorer pick ideas automatically; keep dedupe and cooldown. | V10 |
| M07 | Script & storyboard | **[Rework]** | Output a shot list (3–10 s shots, keyframe + motion prompt, VO line, on-screen text). Required non-empty hook/CTA. Channel narrator voice. | V1, V4 |
| M08 | Provider registry & ledger | **[Keep]** | Extend: capability registry, router with fallback and circuit breaker, per-second video cost. Keep ledger keys. | V2 |
| M09 | Scene media generation | **[Rework]** | Becomes Shot Generation: keyframe image then image-to-video, async submit/poll jobs, no long HTTP request. | V2, V5 |
| M10 | Composition & export | **[Keep]** | Engine already takes video scenes, ASS captions and a music mix. Add scale/crop normalise, transitions, ducking, word captions, loudness. | V1, V5 |
| M11 | QA & approval | **[Rework]** | AI critic watches the cut; scored rubric triggers targeted reshoots. Approval becomes optional single tap. | V6 |
| M12 | Social accounts | **[Keep]** | YouTube OAuth already in place. | V9 |
| M13 | Publishing & calendar | **[Keep]** | Add auto-slotting by cadence and the containsSyntheticMedia flag. | V9 |
| M14 | Analytics store | **[Keep]** | Feeds learning unchanged. | V10 |
| M15 | Learning | **[Rework]** | Auto-tunes idea-scoring weights and format mix within bounds; prompt/config changes stay recommendations (amend ADR-009). | V10 |
| M16 | Orchestration & scheduler | **[Rework]** | Becomes the VideoRun engine: Postgres state machine + BullMQ flows. Script-approval wait only at L1 (amend ADR-017 #2). | V3 |
| M17 | Notifications | **[Keep]** | Sends the approval tap and daily digest. | V8 |
| M18 | Budget & billing foundation | **[Keep]** | Add per-video budget envelope and seeded defaults on workspace create. | V1, V3 |
| M19 | Admin, audit, observability | **[Keep]** | Add run traces, cost per run, provider health. | V3, T2 |
| M20 | Release gate | **[Keep]** | Process stays. | T2 |
| M21 | Design system | **[Keep]** | Unchanged. | Used by V7, V8 |
| M22 | Auth & onboarding UI | **[Rework]** | Onboarding = 5-question Channel Brief, then the first short starts. | V7 |
| M23 | Channel config UI | **[Rework]** | Collapse to a Brief editor; genre, series and prompts move under Advanced. | V7 |
| M24 | Ideas & storyboard workspace | **[Rework]** | Demote to read-only run detail with optional edits; not the main path. | V8 |
| M25 | Generation studio | **[Rework]** | Replace with a live Run Timeline (SSE progress, per-shot previews, reshoot one shot). | V8 |
| M26 | Review & regeneration UI | **[Rework]** | Mobile approval inbox with the critic report and one-tap approve. | V8 |
| M27 | Publishing UI & calendar | **[Keep]** | Keep calendar; composer pre-filled by the Packaging agent. | V9 |
| M28 | Analytics UI | **[Rework]** | Not started (a basic /insights screen exists); extend that screen into performance + what the AI learned. | V10 |
| M29 | Monitoring & usage dashboard | **[Keep]** | Add cost per short and per provider. | V8 |
| M30 | Hardening & launch | **[Keep]** | After the vertical slice (#91, #92). | T2 |
| M31 | SaaS billing | **[Drop/Defer]** | Not needed until external users. | Deferred |
| M32 | Team collaboration | **[Drop/Defer]** | Out of v2 scope. | Deferred |
| M33 | Research & trends | **[Promote]** | Becomes the Trend Scout at the head of the pipeline. | V10 |
| M34 | Localization & multiplatform | **[Drop/Defer]** | After YouTube Shorts quality is proven. | Deferred |

Also drop: the still-image scene path as a production default (kept for keyframes and covers only), the dead OpenAI Videos adapter, and manual per-scene asset assignment (deleted in T2, replaced by per-shot reshoot and the reference library). ADRs to amend: 009, 011 and 017 #2. ADR-025 is superseded by a new provider-strategy ADR.

## Zero-config defaults

| Default | Value | Fixes |
| --- | --- | --- |
| Prompt pack v1 | Versioned prompts for every agent shipped in code, seeded idempotently by migration/boot with no network calls | Fresh workspace can't script |
| Format templates | 8 built-ins: explainer, top-3, story, myth vs fact, what-if, history moment, quick how-to, news recap | No genre UI |
| Budget policy | Created with each workspace: $6 target and $8 cap per Short, $20/day, $180/month (fits 1 Short/day), editable | 'No workspace provider budget' |
| Narrator | Channel-level voice per language; characters optional | MISSING_VOICE |
| Script schema | Hook 1–20 words, CTA 1–15 words, non-empty, total words fit duration | Blank hook/CTA |
| Render profile | 1080×1920, 24 fps (Omni's native rate), H.264; any input scaled/cropped to fit | 1024×1536 rejection |
| Retry UX | Interrupted saves reconcile automatically in the background; the banner is info-only | Reconcile banner blocks retry |
| Execution | Every generation step is an async job with SSE progress | 'Response interrupted' |
| Providers | One secret: GEMINI_API_KEY (env, or pasted once in Settings and stored encrypted). Health page shows a capability matrix | Manual config |
| Autonomy and cadence | L2, 1 Short/day at 18:00 channel timezone, English narration, AI disclosure on | — |

## Roadmap: 12 requirements

> **Merged for speed on Tushar's request**: V1–V10 build every v2 feature; T1–T2 are product testing and integration. Up to 4 coding agents run in parallel. The first real-video Short arrives at the end of V5, about 3 waves in.

| Req | Title | Wave | Depends on | Runs in parallel with | Size |
| --- | --- | --- | --- | --- | --- |
| V1 | Foundations, contracts and fresh-install fixes | Wave 0 | None | Runs alone; everything else waits for its contracts | M (about 3 agent-days) |
| V2 | Provider layer: ports, router, Gemini + xAI adapters | Wave 1 | V1 | Parallel with V3, V4, V7 | L (about 4 agent-days) |
| V3 | VideoRun orchestrator, per-video budget, SSE progress | Wave 1 | V1 | Parallel with V2, V4, V7 | L (about 4 agent-days) |
| V4 | Creative planning agents: script, shot list, art direction | Wave 1 | V1 (V2 text port; stub until merged) | Parallel with V2, V3, V7 | M (about 3 agent-days) |
| V5 | Media generation and assembly: first real-video Short | Wave 2 | V2, V3, V4 | Parallel with V8, V10; T1 bake-off beside it | L (about 4 agent-days) |
| V6 | AI critic, auto-redo and packaging | Wave 3 (starts in Wave 2 on fixtures) | V5 (V2 multimodal text) | Parallel with V8, V10 | M (about 3 agent-days) |
| V7 | Channel Brief, onboarding and settings UI | Wave 1 | V1 (V2 health data and V3 run-create API; stubs until merged) | Parallel with V2, V3, V4 | M (about 3 agent-days) |
| V8 | Run Timeline, approval inbox and autonomy levels | Wave 2 | V3 (SSE), V1 | Parallel with V5, V10 | M (about 3 agent-days) |
| V9 | Publishing automation | Wave 3 (starts in Wave 2 on stubs) | V8; V6 packaging fields (stub until merged) | Parallel with V6 and T1; off the critical path | S–M (about 2 agent-days) |
| V10 | Trend discovery, idea scoring and learning loop | Wave 2 | V2, V1 | Parallel with V5, V8 | M (about 3 agent-days) |
| T1 | Real-provider end-to-end test and quality harness | Waves 2–4 | V2 (bake-off); V5 + V6 (full runs) | Bake-off beside V5; full runs beside V9 | M (about 3 agent-days) |
| T2 | Integration, E2E and release hardening | Wave 4 | V7, V8, V9, V10, T1 | Last; overlaps late T1 runs | M (about 4 agent-days) |

### Dependencies and waves

**Diagram (horizontal):**

Nodes: V1 Foundations (Wave 0); V2 Providers (Wave 1); V3 Orchestrator (Wave 1); V4 Planning agents (Wave 1); V7 Brief + onboarding (Wave 1); V5 First real Short (Wave 2); V8 Timeline + approval (Wave 2); V10 Discovery + learning (Wave 2); V6 Critic + packaging (Wave 3); V9 Publishing (Wave 3); T1 Live quality test (Waves 2–4); T2 E2E + release (Wave 4)

Edges:
- V1 Foundations → V2 Providers
- V1 Foundations → V3 Orchestrator
- V1 Foundations → V4 Planning agents
- V1 Foundations → V7 Brief + onboarding
- V2 Providers → V5 First real Short
- V3 Orchestrator → V5 First real Short
- V4 Planning agents → V5 First real Short
- V3 Orchestrator → V8 Timeline + approval
- V2 Providers → V10 Discovery + learning
- V5 First real Short → V6 Critic + packaging
- V6 Critic + packaging → V9 Publishing
- V8 Timeline + approval → V9 Publishing
- V2 Providers → T1 Live quality test [bake-off]
- V6 Critic + packaging → T1 Live quality test
- T1 Live quality test → T2 E2E + release
- V9 Publishing → T2 E2E + release
- V10 Discovery + learning → T2 E2E + release
- V7 Brief + onboarding → T2 E2E + release

1. **Wave 0: V1 (1 agent)** — Contracts, ADRs, defaults and bugs 1–5. Everything else builds on its contracts.
2. **Wave 1: V2, V3, V4, V7 (4 agents)** — Providers, orchestrator, planning agents and onboarding UI touch separate modules.
3. **Wave 2: V5, V8, V10 (3 agents) + T1 bake-off** — V5 delivers the first real-video Short; V6 can start on fixture cuts; V9 can start against stubs and a fake YouTube adapter.
4. **Wave 3: V6, V9 (2 agents) + T1 full runs** — Critic and packaging, then publishing automation.
5. **Wave 4: T2** — E2E, live YouTube publish, 7-day soak, deploy readiness.

Critical path: V1 → V2/V3 → V5 → V6 → T1 full runs → T2. V9 is off the critical path: it builds on stubs and lets YouTube's publishAt do the timing. Shared-contract changes after V1 go through Core review to avoid merge conflicts between parallel agents.

### Requirement detail (all 12)

#### V1: Foundations, contracts and fresh-install fixes

- **Goal:** Lock the v2 decisions and shared contracts, and make a fresh install work with zero manual DB edits.
- **Wave and size:** Wave 0 · M (about 3 agent-days)
- **Depends on:** None
- **Parallel with:** Runs alone; everything else waits for its contracts

**Features included**

- Docs PR: ADR-026 provider strategy, ADR-027 VideoRun orchestrator, ADR-028 autonomy levels; amend ADR-009, 011, 017 #2; supersede ADR-025; ADR-028 cites ADR-005 and the ADR-019 emergency stop
- Shared contracts + migration: ChannelBrief, VideoRun, VideoRunStep, ShotSpec, ProviderCapability, RunEvent, BudgetEnvelope, ReferenceAsset (id, kind CHARACTER/STYLE/SCENERY/PROP, source SYSTEM/PRESET/UPLOADED/USER_GENERATED, immutable versions on M04) and ChannelReferenceDefaults
- Idempotent no-network seeding: prompt pack v1, 8 format templates, render profile 1080×1920 at 24 fps (matches Omni output), budget policy ($6 target, $8/Short cap, $20/day, $180/month so 1 Short/day fits), English narration, L2 autonomy, 1 Short/day at 18:00, AI disclosure on
- Bug 1: fresh workspace can't script (seeded prompts, budget, formats)
- Bug 2: MISSING_VOICE (channel-level narrator voice)
- Bug 3: render rejects 1024×1536 (scale/crop any input)
- Bug 4: reconcile banner blocks retry (background reconcile, info-only banner)
- Bug 5: empty hook/CTA (hook 1–20 words, CTA 1–15 words)
- Remove the dead OpenAiVideoProvider (apps/api/src/modules/openai); OpenAI text becomes a configurable fallback
- Every new table workspace-scoped through the ADR-003 guard
- Strangler setup: pipeline.v2 flag (off by default) so VideoRun is built alongside the old flow
- DEPRECATIONS.md inventory + @deprecated markers on every superseded module, endpoint, screen and table, each with its replacing and removing requirement
- Quality tooling: knip (unused files, exports, deps) baseline, coverage floor on changed code, max-lines lint guideline, pinned per ADR-012; CI wiring in a separate chore PR

**Acceptance criteria**

- [ ] ADR docs PR merged before the code PR
- [ ] New workspace generates a script with a stub provider and zero DB edits (E2E)
- [ ] 1024×1536, 720×1280 and 1080×1920 inputs all render to 1080×1920 at 24 fps
- [ ] Empty or over-length hook/CTA rejected before any paid call
- [ ] Narrator-only script passes the voice step
- [ ] Retry works without dismissing the banner
- [ ] Contracts importable by V2–V10
- [ ] Cross-workspace access to new tables rejected
- [ ] Inventory covers every row of the deprecation table; knip baseline committed and can only shrink

#### V2: Provider layer: ports, router, Gemini + xAI adapters

- **Goal:** One provider layer that makes real video, images, voice, music and text, with routing, fallback and per-second costing.
- **Wave and size:** Wave 1 · L (about 4 agent-days)
- **Depends on:** V1
- **Parallel with:** Parallel with V3, V4, V7

**Features included**

- Ports: VideoGen (capabilities, estimate, submit, poll, fetch), ImageGen, TTS, Music, Text (structured JSON + multimodal input)
- Capability registry with prices per second per resolution; model ids in config
- Router: tier, capability, price, health; circuit breaker; fallback on outage only; refusal = one prompt rewrite then NEEDS_HUMAN; 429 / spend-rate limits = backoff via a per-provider concurrency limiter, never a vendor switch
- Gemini adapters: Omni 1.2 Flash (T2V, I2V, first/last frame, 6 refs, extension, 9:16, 720p, 24 fps; background mode + URI delivery), Nano Banana 2.1, Gemini 3.8 Flash text, Gemini 3.8 Flash TTS, Lyria 3.5
- xAI grok-imagine-video-1.5 fallback adapter
- Per-second cost via reservePaidCall → ledger → finishPaidCall (m08:<correlationId>)
- Key binding from env plus encrypted key storage API; provider health and capability data
- Cleanup: rebind the old flow's image/TTS ports to Gemini, then delete the OpenAI image and TTS adapters and old default model ids

**Acceptance criteria**

- [ ] Fake-fetch tests per adapter: submit, poll, fetch, refusal, timeout
- [ ] Router tests: outage goes to xAI; refusal and 429 never switch vendor
- [ ] Ledger amount = billed seconds × catalog rate
- [ ] No live calls in tests, CI, startup, seed or health
- [ ] Opt-in live smoke makes one 8 s 9:16 clip (only when Tushar authorizes)

#### V3: VideoRun orchestrator, per-video budget, SSE progress

- **Goal:** A durable per-video state machine that runs every step as an async job, enforces the $6/$8 budget, and streams progress.
- **Wave and size:** Wave 1 · L (about 4 agent-days)
- **Depends on:** V1
- **Parallel with:** Parallel with V2, V4, V7

**Features included**

- VideoRun states incl. PAUSED_BUDGET, NEEDS_HUMAN; guarded server-side transitions
- BullMQ FlowProducer fan-out per shot, fan-in to assembly; delayed polls every 10–15 s; resume-on-boot sweep; idempotency keys
- Per-video budget: estimate before first spend; warn above $6; refuse above $8; envelope = base estimate + reshoot reserve (50% of clip cost), hard-capped at $8; on fallback, re-estimate at fallback rates and drop the reserve if needed; honours M18 caps and the M19 emergency stop
- RunEvents → Redis pub/sub → SSE at /api/v1/runs/:id/events
- Bug 6: no long HTTP request; every generation step is a job
- Artifact storage via the existing M04 StoragePort (local driver; S3 adapter in T2), content-addressed; drafts 14 days, finals forever
- Spans per step and provider call via the existing M19 tracing (OTel field names, no new SDK); cost-per-run metrics
- Cleanup: old M16 GENERATION definition and 72 h script wait marked deprecated; reachable only with pipeline.v2 off

**Acceptance criteria**

- [ ] Worker killed mid-GENERATING resumes with zero duplicate paid calls
- [ ] Estimate above $8 refused before any paid call
- [ ] Simulated mid-run outage re-estimates at xAI rates and stays at or under $8
- [ ] Reshoot over the envelope goes to PAUSED_BUDGET or NEEDS_HUMAN
- [ ] SSE emits every transition in order
- [ ] No API request waits on media generation
- [ ] Emergency stop halts new paid calls within one poll cycle

#### V4: Creative planning agents: script, shot list, art direction

- **Goal:** Turn an idea into a strict script, a shot list and a reusable channel reference set before any media spend.
- **Wave and size:** Wave 1 · M (about 3 agent-days)
- **Depends on:** V1 (V2 text port; stub until merged)
- **Parallel with:** Parallel with V2, V3, V7

**Features included**

- Scriptwriter: strict JSON hook (3 s or less), 3–5 beats, payoff, CTA; uses format templates
- Director: about 6 shots of 6–8 s with keyframe prompt, motion prompt, VO line, on-screen text, refs, continuity notes
- Art Director: channel reference set and voice id as versioned M04 characters, reused across runs
- Pluggable reference-asset library: agents resolve character, style and scenery refs by id + version through a ReferenceLibrary port with per-channel defaults; v2 fills it with AI-generated assets, and U1/U2 only add new sources
- Ref selection rule: at most 6 refs per Omni call (character first, then scenery, then style); every shot pins ref ids + versions in the manifest
- Guardrail pre-screen: no real people or brands, banned topics, no AI persona giving health, legal, finance or political advice, no artist names or lyrics in music prompts
- Prompt versions recorded in snapshots (M05)
- Script and narration in the Brief language (default English); non-English runs keep speech in TTS, since Omni is only fully evaluated in English

**Acceptance criteria**

- [ ] Invalid agent output rejected before spend
- [ ] Shot durations sum to target within 1 s
- [ ] Fixtures pass for all 8 formats
- [ ] Reference set reused across runs of one channel
- [ ] Changing a channel's default character id changes every shot with no code change (fixture)
- [ ] Manifest pins ref ids + versions
- [ ] Real-person prompt and AI-doctor/finance-advisor persona blocked

#### V5: Media generation and assembly: first real-video Short

- **Goal:** Inside the product, one channel produces one 30–45 s 9:16 Short of real AI video clips with voice, captions and music.
- **Wave and size:** Wave 2 · L (about 4 agent-days)
- **Depends on:** V2, V3, V4
- **Parallel with:** Parallel with V8, V10; T1 bake-off beside it

**Features included**

- Keyframe per shot (Nano Banana 2.1, 9:16, channel refs)
- Image-to-video per shot via the router (Omni 720p); first/last-frame continuity; match cuts; optional extension; shots in parallel
- Channel-voice narration, Lyria music bed (instrumental only), word-timed captions in the narration language (local forced alignment)
- M10 assembly: 1080×1920 at 24 fps, crossfades, ambience at -18 dB, ducking, -14 LUFS, safe-zone captions, cover frames
- Manifest with prompt versions, provider job ids, seconds and cost
- Still-image scenes removed as a production path
- Cleanup: delete the synchronous scene-media generate endpoint and still-image scene code in this PR

**Acceptance criteria**

- [ ] One channel → one 30–45 s Short from real clips, no still-image scenes
- [ ] Voice, captions and music; 720p clips, final 1080×1920
- [ ] Ledger total at most $8
- [ ] Manifest complete
- [ ] Offline fixture render passes; first live run only with Tushar's authorization

#### V6: AI critic, auto-redo and packaging

- **Goal:** Automated QA that redoes weak shots within budget, then packages the Short for YouTube.
- **Wave and size:** Wave 3 (starts in Wave 2 on fixtures) · M (about 3 agent-days)
- **Depends on:** V5 (V2 multimodal text)
- **Parallel with:** Parallel with V8, V10

**Features included**

- Per-clip hard checks: ffprobe, black/frozen frames, duration, aspect
- Multimodal critic rubric 0–10 (hook, coherence incl. a clear narrative arc, artifacts, caption sync, brief fit, policy); pass at 7+ with no axis under 5
- Targeted reshoots: max 2 per shot, 1 re-edit per run, inside the envelope
- Novelty/variety check against channel history
- Packaging: title, description, tags, cover frame, containsSyntheticMedia=true (custom Shorts thumbnail via API is best-effort, not verified)
- Cleanup: delete the superseded single-pass M11 AI review path

**Acceptance criteria**

- [ ] Seeded defect fixtures all caught
- [ ] Reshoots stop at caps and envelope
- [ ] Packaging within YouTube limits
- [ ] Score can never override hard gates

#### V7: Channel Brief, onboarding and settings UI

- **Goal:** A user sets up a channel once in 5 inputs and the first Short starts.
- **Wave and size:** Wave 1 · M (about 3 agent-days)
- **Depends on:** V1 (V2 health data and V3 run-create API; stubs until merged)
- **Parallel with:** Parallel with V2, V3, V4

**Features included**

- Channel Brief editor: niche, audience, language, style bible, voice, cadence, budget, autonomy, guardrails
- 5-question onboarding wizard that queues the first run
- Genre, series and prompts moved under Advanced
- Settings: paste Google and xAI keys once (encrypted, never echoed); provider health page

**Acceptance criteria**

- [ ] Sign-up to first queued Short in 5 inputs or fewer, zero DB edits
- [ ] Keys never returned to the browser or logs
- [ ] axe clean on new screens

#### V8: Run Timeline, approval inbox and autonomy levels

- **Goal:** Watch a run live, approve with one tap, and grow from approve-before-publish to full auto safely.
- **Wave and size:** Wave 2 · M (about 3 agent-days)
- **Depends on:** V3 (SSE), V1
- **Parallel with:** Parallel with V5, V10

**Features included**

- Run Timeline: live SSE steps, per-shot previews, cost so far, manual reshoot of one shot
- Read-only run detail (M24 demoted)
- Mobile approval inbox with critic report, one-tap approve/reject
- Autonomy engine: L2 forced for the first 10 Shorts, then offer L3 with the critic-agreement score shown (recommended at 8 of 10 or better); L3 gate failure falls back to L2
- Notifications: approval request and daily digest
- Usage dashboard: cost per Short and per provider
- UI switch-over: pipeline.v2 on by default; old /planning edit, /production and /review screens hidden from navigation and marked deprecated

**Acceptance criteria**

- [ ] Approve from a phone in one tap
- [ ] L3 unavailable before 10 approved Shorts; offer with agreement score shown after
- [ ] Failed L3 run lands in the inbox
- [ ] Timeline updates live

#### V9: Publishing automation

- **Goal:** Approved Shorts publish themselves on the channel's cadence with AI disclosure.
- **Wave and size:** Wave 3 (starts in Wave 2 on stubs) · S–M (about 2 agent-days)
- **Depends on:** V8; V6 packaging fields (stub until merged)
- **Parallel with:** Parallel with V6 and T1; off the critical path

**Features included**

- Auto-slotting by cadence in the channel timezone (DST-safe); on approval, upload as private with status.publishAt so YouTube publishes at the slot
- Preflight reuses M13 hard gates; nothing publishes without approval at L1/L2
- videos.insert with containsSyntheticMedia=true and packaged metadata; 100/day bucket respected; revoked OAuth → NEEDS_HUMAN with reconnect prompt
- Calendar shows auto slots; composer pre-filled; uncertain uploads reconciled

**Acceptance criteria**

- [ ] Approved run lands in the next free slot
- [ ] Unapproved run never publishes at L2
- [ ] Fake YouTube adapter confirms synthetic flag and idempotent upload
- [ ] DST test passes
- [ ] Revoked-token test lands in NEEDS_HUMAN with no duplicate upload

#### V10: Trend discovery, idea scoring and learning loop

- **Goal:** The AI finds and ranks ideas itself and gets better from each Short's analytics.
- **Wave and size:** Wave 2 · M (about 3 agent-days)
- **Depends on:** V2, V1
- **Parallel with:** Parallel with V5, V8

**Features included**

- Trend Scout: Gemini Search grounding, YouTube charts/search inside the separate 100 search.list/day bucket (Scout uses at most 20/day), channel analytics (M33 promoted)
- Idea Scorer: novelty, trend velocity, brief fit, predicted retention, cost, policy risk; dedupe and cooldown
- Learning: bounded, audited auto-tuning of scoring weights and format mix; prompt/config changes stay recommendations
- Analytics UI: performance plus what the AI learned (M28), extending the existing /insights screen

**Acceptance criteria**

- [ ] Scheduled tick produces ranked, sourced ideas with no user input
- [ ] Duplicate topic inside cooldown rejected
- [ ] Weight changes bounded per week and audited
- [ ] M28 page shows performance and learned changes

#### T1: Real-provider end-to-end test and quality harness

- **Goal:** Prove with live providers that Shorts rate 7/10+ inside budget, and that fallback and resume work for real.
- **Wave and size:** Waves 2–4 · M (about 3 agent-days)
- **Depends on:** V2 (bake-off); V5 + V6 (full runs)
- **Parallel with:** Bake-off beside V5; full runs beside V9

**Features included**

- Authorized live budget: about 10 runs (about $60) plus a bake-off (about $8); move Gemini to Tier 2 first (Tier 1 caps spend at $250/month)
- Bake-off: same 3 shots on Omni and Grok Imagine 1.5 in the product; Kling 4.0 Flash by hand in Kling's console (no adapter)
- Rating harness: Tushar scores 1–10, compared with critic scores
- Cost report vs $6 target / $8 cap
- Forced primary outage completes on Grok Imagine within $8
- Live worker-kill resume and Tier 1 rate limits

**Acceptance criteria**

- [ ] At least one Short rated 7/10+ (target median 7+ over 5)
- [ ] Every run at most $8; median at most $6
- [ ] Fallback run completes with costs recorded
- [ ] Zero duplicate charges, zero manual DB edits

#### T2: Integration, E2E and release hardening

- **Goal:** The whole product is tested end to end, publishes live to YouTube, and is ready to deploy.
- **Wave and size:** Wave 4 · M (about 4 agent-days)
- **Depends on:** V7, V8, V9, V10, T1
- **Parallel with:** Last; overlaps late T1 runs

**Features included**

- Playwright + axe E2E: onboarding → run → approve → schedule (continues #79)
- Live YouTube publish check with synthetic flag (#89); full flow (#90)
- 7-day soak at 1 Short/day at L2
- M19 span exporter, dashboards, alerts, retention job, KMS; S3-compatible storage adapter for hosting; Gemini project spend cap and xAI balance alert
- Deploy readiness: hosting (#91), launch checklist (#92), M30; docs closeout via chore PR
- Final cleanup gate: delete every DEPRECATIONS.md item (old screens, routes, endpoints, workflow, tables via ADR + migration), remove the pipeline.v2 flag, zero knip findings

**Acceptance criteria**

- [ ] E2E suite green
- [ ] One live private/unlisted Short published with the synthetic flag
- [ ] 7-day soak completes
- [ ] Launch checklist complete
- [ ] DEPRECATIONS.md empty; knip reports zero unused files, exports and dependencies; no feature flags left from v1

### Coverage: every v2 feature and old milestone

| Feature | Owner (exactly one) | Also touches |
| --- | --- | --- |
| Channel Brief (one-time setup, incl. language) | V7 | V1 contract |
| Autonomy levels L1/L2/L3 + first-10 rule | V8 | V1 ADR-028 + L2 default |
| Trend discovery | V10 | — |
| Idea scoring, dedupe, cooldown | V10 | — |
| Script with required hook/CTA | V4 | V1 schema (bug 5) |
| Shot list | V4 | — |
| Reference-asset library (ids, versions, channel defaults) | V4 | V1 contracts |
| Content guardrails (real people, brands, AI-persona advice, music prompts) | V4 | V6 policy axis |
| Script, narration and caption language | V4 | V5 captions, V7 Brief field |
| Preset character library (future) | U1 | extends V4 library |
| Custom character/scenery upload and generation (future) | U2 | extends V4 library |
| Provider adapters: Omni, Nano Banana 2.1, 3.8 Flash, TTS, Lyria | V2 | — |
| Grok Imagine 1.5 fallback | V2 | T1 live outage test |
| Router, circuit breaker, refusal and 429 handling | V2 | — |
| Provider keys: env binding + encrypted storage | V2 | V7 settings UI |
| Keyframes | V5 | — |
| Image-to-video clips | V5 | V2 adapter |
| Voice / narration | V5 | V2 adapter |
| Music | V5 | V2 adapter |
| Captions | V5 | — |
| Assembly / edit (normalise, transitions, ducking, loudness) | V5 | V1 normalise fix (bug 3) |
| AI critic + auto-redo | V6 | — |
| Packaging + synthetic-media flag + cover frame | V6 | — |
| VideoRun state machine, idempotency, resume | V3 | — |
| Per-video budget $6 / $8, fallback re-estimate, emergency stop | V3 | V1 seeded defaults |
| SSE event stream | V3 | — |
| Storage and retention | V3 | T2 S3 adapter for hosting |
| Run traces and cost metrics | V3 | — |
| Run Timeline UI | V8 | — |
| Approval gate (one tap) | V8 | V3 states |
| Notifications + usage dashboard | V8 | — |
| Publishing automation, publishAt scheduling, OAuth/quota handling | V9 | — |
| Analytics learning loop + analytics UI | V10 | — |
| Settings page for keys + provider health | V7 | V2 health data |
| Fresh-install defaults | V1 | — |
| Workspace isolation for new tables | V1 | — |
| Friday bugs 1–5 | V1 | — |
| Friday bug 6 (long HTTP request) | V3 | — |
| pipeline.v2 flag + DEPRECATIONS.md inventory | V1 | — |
| UI switch-over to VideoRun | V8 | — |
| Old-flow deletion + flag removal (final cleanup gate) | T2 | early deletions in V1, V2, V5, V6 |
| Code quality tooling (knip, coverage, size rules) | V1 | rules apply to every PR |
| Live quality rating + bake-off | T1 | — |
| Dashboards, alerts, span exporter, KMS | T2 | — |
| E2E, live YouTube check, 7-day soak, deploy readiness | T2 | — |

| Old milestone | Folded into |
| --- | --- |
| Old R0 (ADRs) | V1 |
| Old R1 (fresh-install fixes) | V1 |
| Old R2 (VideoGenPort + Omni + per-second cost) | V2 |
| Old R3 (VideoRun engine + SSE) | V3 |
| Old R4 (shot planner, keyframes, I2V, assembly) | V4 + V5 |
| Old R5 (critic, reshoots, packaging) | V6 |
| Old R6 (Brief onboarding, approval inbox, autonomy) | V7 + V8 |
| Old R7 (Trend Scout, auto-publish, learning, 7-day soak) | V9 + V10; soak in T2 |
| Old R8 (fallback adapter + router health) | V2; outage test in T1 |
| Old R9 (hardening and launch) | T2 |
| Old vertical-slice issue (one channel → one real Short) | V5 + T1 |

All 35 modules M00–M34 are mapped to a requirement in the Module map's Requirement column. M31, M32 and M34 stay deferred, as in the plan.

## Code quality and cleanup

> **Decided: refactor with a strangler approach, not a rewrite** _(success)_: Build the VideoRun pipeline alongside the old flow behind the pipeline.v2 flag (V1). Switch the UI over in V8, then delete the old manual screens, endpoints, workflow and tables. Delete as early as each replacement passes, with the T2 cleanup gate as the backstop.

### Deprecation list

| Module | What gets deprecated | Replaced by | Deleted in |
| --- | --- | --- | --- |
| M08 / api openai module | Dead OpenAiVideoProvider (openai.adapters.ts) | V2 Omni adapter | V1 |
| M08 / api openai module | OpenAI image and TTS adapters, gpt-4.1-mini / gpt-4o-mini-tts defaults | V2 Gemini adapters | V2 |
| M03 | Genre as a required choice | V1 seeded format templates | V1 |
| M05 | Manual prompt-snapshot setup path | V1 seeded prompt pack | V1 |
| M07 | Per-scene character-voice requirement and old script fields | V1 narrator + V4 shot list | Code in V4; columns in T2 (ADR + migration) |
| M09 | Synchronous scene-media generate endpoint and still-image scene path | V3 jobs + V5 image-to-video | V5 |
| M09 / C3 | Manual per-scene asset assignment | V8 per-shot reshoot | T2 |
| M11 | Single-pass AI review | V6 critic + reshoot loop | V6 |
| M16 | Old GENERATION workflow definition and 72 h script wait | V3 VideoRun | T2, after V8 switch |
| M06 / M24 | Manual idea approval and /planning edit screens | V10 auto scoring; V8 read-only run detail (L1 keeps approvals) | T2 |
| M25 | /production studio, jobs and renders screens; manual render start (C4) | V8 Run Timeline | T2 |
| M26 | /review screens | V8 approval inbox | T2 |
| M23 | Old channel/genre/series config screens | V7 Brief editor (Advanced) | T2 |
| Database | Tables/columns only used by the old scene and workflow flow (exact list in the V1 inventory) | VideoRun, VideoRunStep, ReferenceAsset | T2, one ADR + migration per table |
| Flags | pipeline.v2 flag and the old-flow code behind it | VideoRun default | T2 |

### Rules for every PR

- No dead code: superseded code is deleted in the same PR, or the next one at the latest, and struck from DEPRECATIONS.md
- knip passes: no new unused files, exports or dependencies (baseline only shrinks); knip replaces ts-prune, which is unmaintained
- Strict lint and typecheck with zero warnings; no new any, ts-ignore or eslint-disable without a linked reason
- Coverage floor on new and changed code: 80% lines, 70% branches (Vitest v8 coverage)
- Size guideline: files under 400 lines, functions under 60 lines; the 2,257-line scene-media.service.ts is split when touched
- Removing a DB table or column needs an ADR plus a reversible-by-backup migration, never in the same PR that stops writing to it
- New dev tools are pinned per ADR-012; CI changes go in separate chore PRs (no ci.yml in product PRs)

### Final cleanup gate (inside T2)

- [ ] All old manual screens and routes deleted (/planning edit, /production, /review, old config screens)
- [ ] Old endpoints, the M16 GENERATION definition and the C3/C4 manual paths deleted
- [ ] Deprecated tables and columns dropped via ADR + migration
- [ ] pipeline.v2 and any other v1 feature flags removed
- [ ] DEPRECATIONS.md empty; knip reports zero unused files, exports and dependencies
- [ ] Full test suite, E2E and typecheck green after removal

Status as of 2026-11-16: not started; this is the gate T2 must pass.

## Future upgrades

| Upgrade | What users get | How it plugs in |
| --- | --- | --- |
| U1 Preset character library | Pick characters from a curated predefined list in the Channel Brief; the chosen character stays consistent across every shot of a video and across videos | Adds PRESET ReferenceAssets (ref images + voice id + style notes) to the V4 library and lets the Brief set them as channel defaults. No pipeline change. |
| U2 Custom characters and scenery | Upload your own character, scenery or prop images, or generate them from a description, then reuse them like presets | Adds UPLOADED and USER_GENERATED sources with rights check, likeness guardrails and an approval step; same ids, versions and resolution path. |

V1 and V4 already define reference assets as a versioned, id-based library with per-channel defaults, so U1 and U2 only add sources and UI.

## Risks and decisions (decided 2026-11-16)

| Risk | Mitigation |
| --- | --- |
| Model churn: Sora, gpt-image-1 and Veo previews all died within a year | Port + capability registry + fallback vendor; model ids in config, not code |
| Omni quality or consistency not good enough | 3-way bake-off in T1 right after V2; Kling 4.0 or Grok Imagine 1.5 can be promoted to primary |
| Content refusals on prompts | Pre-screen prompts; one automatic rewrite; then NEEDS_HUMAN |
| YouTube inauthentic-content demonetisation | Real angle per video, format variety, AI disclosure, L2 by default, novelty score against history |
| Cost overrun from reshoots | Per-run envelope, reshoot caps, monthly caps from M18 |
| Rate limits (Tier 1 = 40 clips/day) | Spread runs over the day; move to Tier 2 before more than 3 Shorts/day |
| Gemini Tier 1 limits: $250/month billing cap, $10 per 10 min spend rate | Reach Tier 2 ($100 paid + 3 days) before T1; per-provider concurrency limiter; project spend cap in AI Studio |
| Omni only fully evaluated in English | Default English; non-English channels keep speech in TTS with no on-screen dialogue |
| New model churn (Omni 1.1 routes to 1.2 on 2026-12-03) | Model ids in config; capability registry re-checked at each provider PR |
| Likeness and IP | Guardrail blocks real people and brands; Omni rejects recognizable-person uploads |

> **Decided by Tushar on 2026-11-16** _(success)_: All three v2 decisions are approved, and the plan was locked as v2.0 on 2026-11-16 after a final audit (see Changelog). V1 is next; any later change needs a changelog entry.

| Decision | Status | Outcome |
| --- | --- | --- |
| Video vendor | **[DECIDED]** | Gemini Omni 1.2 Flash primary; xAI Grok Imagine 1.5 fallback |
| Budget per Short | **[DECIDED]** | $6 target, $8 hard cap, 720p clips upscaled to 1080×1920 |
| Autonomy default | **[DECIDED]** | Approve before publish for the first 10 Shorts, then offer full auto |
| Migration approach | **[DECIDED]** | Refactor with a strangler approach: build alongside, switch UI in V8, delete old flow by T2 |
| Code quality | **[DECIDED]** | Per-PR rules, knip, coverage floor, deprecation inventory, T2 cleanup gate |
| Plan status | **[LOCKED v2.0]** | Locked 2026-11-16 after the final audit |

## Changelog: lock audit, 2026-11-16

| Area | What changed |
| --- | --- |
| Prices | Omni 720p re-derived as $0.0695/s (5,792 tokens/s × $12/1M); cost per 45 s Short $5.82 → $5.79. Every other Google, xAI and Kling price re-verified unchanged. Runway, Luma, MiniMax, Pika, Veo on Vertex, ElevenLabs and sync.so marked not re-checked. |
| Vendor facts added | Omni outputs 24 fps, is fully evaluated only in English, bills reference input at $1.50/1M tokens, and needs background mode + URI delivery; Gemini Tier 1 has a $10 per 10 min spend limit and $250/month cap; xAI video limits are published (10 RPS at Tier 0); Lyria safety filter and SynthID. |
| YouTube | search.list has its own 100/day bucket; publishAt scheduling; AI-persona advice and stitched AI clips are not monetisable; AI music needs disclosure. |
| Budget | Envelope formula unified (base + 50% clip reshoot reserve, cap $8); fallback re-estimate rule added because a 45 s Grok Imagine run with 1.5× reshoots would be about $10.63; monthly default $60 → $180 so the default 1 Short/day cadence fits. |
| Render | Profile 1080×1920 at 30 fps → 24 fps to match Omni and avoid judder. |
| Autonomy | After 10 approved Shorts L3 is always offered, with the critic-agreement score shown (was gated on 8 of 10), matching the owner's decision. |
| Integrity | OpenAI adapter path corrected to apps/api/src/modules/openai; M28 extends the existing /insights screen; per-scene asset assignment consistently deleted in T2; V7 depends on V3 run-create (stub); coverage table now names exactly one owner per feature. |
| Missing essentials merged | Workspace isolation for new tables (V1); 429 backoff without a vendor switch (V2); emergency stop, M18 caps, fallback costing (V3); language + AI-persona guardrail (V4); OAuth revoke + quota handling (V9); spend caps, S3 adapter, KMS (T2). |
| Simplified | V3 reuses M04 StoragePort and M19 tracing (no new SDK pins); V9 moved off the critical path (stubs + YouTube publishAt); Kling bake-off done by hand, no adapter. Still 10 build + 2 test requirements. |

## Sources

- [Gemini Omni Flash: video generation guide and limits](https://ai.google.dev/gemini-api/docs/omni) — ai.google.dev
- [Gemini Developer API pricing (Omni, TTS, Lyria, Nano Banana, 3.8 Flash)](https://ai.google.dev/gemini-api/docs/pricing) — ai.google.dev
- [Gemini API rate limits (Omni Flash tiers)](https://ai.google.dev/gemini-api/docs/rate-limits) — ai.google.dev
- [Gemini API billing: tier spend caps](https://ai.google.dev/gemini-api/docs/billing) — ai.google.dev
- [Gemini API changelog (Omni 1.2 Flash GA 2026-11-05)](https://ai.google.dev/gemini-api/docs/changelog) — ai.google.dev
- [xAI rate limits (video RPS by tier)](https://docs.x.ai/developers/rate-limits) — docs.x.ai
- [YouTube: disclosing use of GenAI content](https://support.google.com/youtube/answer/14328491?hl=en) — support.google.com
- [YouTube Data API: videos resource (containsSyntheticMedia, publishAt)](https://developers.google.com/youtube/v3/docs/videos) — developers.google.com
- [OpenAI deprecations (sora-2, gpt-4.1-mini, gpt-4o-mini-tts)](https://platform.openai.com/docs/deprecations) — platform.openai.com
- [Gemini API deprecations (Veo previews shut 2026-10-22)](https://ai.google.dev/gemini-api/docs/deprecations) — ai.google.dev
- [Gemini API additional terms: use of generated content](https://ai.google.dev/gemini-api/terms) — ai.google.dev
- [Vertex / Agent Platform pricing (Veo 3.1)](https://cloud.google.com/vertex-ai/generative-ai/pricing) — cloud.google.com
- [xAI video overview and pricing](https://docs.x.ai/developers/model-capabilities/video/overview) — docs.x.ai
- [xAI API pricing](https://docs.x.ai/developers/pricing) — docs.x.ai
- [Kling API video pricing](https://kling.ai/document-api/pricing/base/video.md) — kling.ai
- [Kling 4.0 text-to-video parameters](https://kling.ai/document-api/api/video/4-0/text-to-video.md) — kling.ai
- [Kling API paid service terms](https://kling.ai/document-api/guides/protocols/paid-service.md) — kling.ai
- [Runway Dev API pricing](https://dev.runway.com/pricing) — dev.runway.com
- [Luma API pricing](https://lumalabs.ai/api) — lumalabs.ai
- [MiniMax pricing overview](https://platform.minimax.io/docs/pricing/overview) — platform.minimax.io
- [Pika H3 Flex text-to-video spec](https://dev.pika.art/llms/pika/pika-h3-flex/text-to-video) — dev.pika.art
- [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) — elevenlabs.io
- [sync.so pricing](https://sync.so/pricing) — sync.so
- [YouTube channel monetization policies (inauthentic content)](https://support.google.com/youtube/answer/1311392?hl=en) — support.google.com
- [YouTube Data API quota costs](https://developers.google.com/youtube/v3/determine_quota_cost) — developers.google.com
- [ReelForge repo (main bb39fc3)](https://github.com/imTusharsingh/reelforge) — github.com


**Page sources:** https://ai.google.dev/gemini-api/docs/omni, https://ai.google.dev/gemini-api/docs/pricing, https://docs.x.ai/developers/model-capabilities/video/overview, https://kling.ai/document-api/pricing/base/video.md, https://dev.runway.com/pricing

