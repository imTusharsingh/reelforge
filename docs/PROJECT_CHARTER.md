# Project Charter: AI Shorts Channel Controller

**Document status:** Baseline proposal frozen for v1 implementation after project-owner acceptance.  
**Project codename:** `shorts-controller`  
**Document version:** 1.0  
**Last updated:** 2026-11-05

## 1. Product statement

Build a configurable AI-assisted channel operations platform. A user configures a channel's niche, genre, series, characters, creative rules, output preferences, budget, and publishing policy. The platform proposes ideas, creates scripts and scene plans, generates media, composes vertical videos, validates output, routes content for approval, publishes through official platform APIs, collects available analytics, and produces recommendations for future content.

The platform is an **AI channel controller**, not a prompt-to-video toy. Its workflows must be observable, resumable, auditable, cost-controlled, and safe to pause.

## 2. Product principles

1. **Correctness before autonomy.** Manual approval is the default. Automation is enabled only through explicit channel policy.
2. **Deterministic orchestration.** Workflow state, transitions, retries, and side effects are implemented in code. LLMs do not decide which arbitrary tools to call.
3. **Typed AI outputs.** Model responses are parsed against versioned schemas. Invalid responses are rejected or retried under bounded policy.
4. **Provider independence.** Domain modules depend on internal ports, not vendor SDKs.
5. **Evidence over assumption.** No API capability, field, metric, quota, or permission is invented. Verify against current official documentation before implementing a connector.
6. **Module ownership.** Each work package has explicit scope, owned files, public interfaces, and acceptance criteria.
7. **No invisible behavior.** Every meaningful job, external side effect, cost, approval, and failure is persisted and traceable.
8. **No fake completion.** A task is not complete because a bot says it is complete; it is complete only when its acceptance criteria and evidence pass review.

## 3. Frozen v1 product decisions

These are the implementation defaults for v1. Changing them requires an approved change request and a new decision-log entry.

| Area | v1 decision |
|---|---|
| Product shape | Multi-tenant-ready workspace model; one user can own multiple workspaces and channels. Team invitations and complex organization hierarchy are deferred. |
| Channel model | One workspace can own multiple channels. A channel can contain multiple content series and character groups. |
| Genre | Built-in starter templates plus user-defined genres. Genre configuration is data-driven, not hardcoded branching. |
| Characters | Starter character library plus user-uploaded character references. Character assets are versioned. No guarantee of pixel-perfect identity; use reference-conditioned generation and explicit visual QA. |
| Prompting | Layered, versioned prompts: system policy, workspace defaults, channel, genre, series, character, task, and user addition. Conflict rules are deterministic. |
| Video format | Vertical 9:16 as the default output. Duration, frame rate, dimensions, and codec are configuration values validated against the selected destination's current requirements. |
| Generation method | Scene-based production: script -> storyboard -> scene assets -> optional image-to-video animation -> voice/audio -> FFmpeg composition. The provider capability must be confirmed before selecting a generation route. |
| Audio | TTS plus user-owned or properly licensed music/SFX assets. Do not generate or use music without documented rights and provider terms. |
| Editing | v1 supports regenerate/replace scene, voice, subtitles, title/description, and cover. Full nonlinear timeline editor is deferred. |
| Quality | Deterministic technical checks plus structured AI review. Safety, rights, file integrity, destination validation, and required approvals are hard gates. Score alone cannot override a hard gate. |
| Approval | Manual approval is the default. Channel-level auto-publish can be enabled only after hard gates pass and configured score thresholds pass. |
| Publishing | YouTube is the first production connector. Instagram is the next connector using the same adapter contract. TikTok and Facebook Reels are not in v1. |
| Analytics | Collect only metrics exposed by the authorized platform APIs and current account permissions. No assumed metric availability. |
| Learning | Recommendations are generated from stored observations. Automatic strategy changes are disabled by default; user approval is required for configuration changes in v1. |
| Scheduling | Daily/weekly generation and publishing schedules, per-channel timezone, pause/resume, bounded retries, budget checks, and manual run are included. |
| Workflow engine | NestJS modular monolith + separate worker process + Redis/BullMQ in v1. Temporal is not part of v1. |
| Database | PostgreSQL + Prisma. The central schema and migrations are controlled by the Core Architect/Reviewer. |
| File storage | S3-compatible object storage in deployed environments; local filesystem adapter for local development. |
| Rendering | FFmpeg invoked as a controlled local process/container with explicit input/output validation. |
| Frontend | Next.js + TypeScript. |
| Backend | NestJS + TypeScript. |
| Repository | pnpm monorepo. Use workspace packages for contracts, provider adapters, media, and shared utilities. |
| Tests | Unit/contract/integration tests are required. No live provider calls or social uploads from ordinary CI. Live verification is a separately authorized, explicitly invoked operation. |

## 4. v1 included scope

- User authentication and workspace isolation.
- Multiple channels per workspace.
- Channel identity, goals, language, audience, content rules, and schedules.
- Configurable genres and content series.
- Predefined and user-uploaded character references and reusable assets.
- Versioned prompt/configuration management with resolved configuration snapshots.
- Idea generation, user idea input, and topic/content similarity checks.
- Structured script and scene-plan generation.
- AI provider registry, capability checks, cost recording, and budget guardrails.
- Scene-level image/video/voice generation through approved real provider adapters.
- Video composition, captions, audio mixing, validation, and final export.
- Quality checks, review queue, approve/reject, and bounded regeneration.
- YouTube connection, OAuth token handling, upload, status tracking, and published-post record.
- Publishing calendar and queue.
- YouTube analytics ingestion where authorized and available.
- AI performance summaries and next-content recommendations.
- Scheduling, workflow execution history, notifications, usage records, audit trail, and emergency pause.

## 5. Release order

**Release 1A - Creator vertical slice:** channel configuration -> idea -> script -> storyboard -> real media generation -> render -> quality review -> manual approval -> downloadable final file.

**Release 1B - YouTube operations:** connect YouTube -> validate metadata/media -> upload using the official API -> verify returned post/video identifier -> persist publishing status -> collect authorized analytics.

**Release 1C - Autonomous operation:** scheduler -> automatic generation queue -> approval policy -> scheduled publishing -> daily/weekly report -> recommendation feedback loop.

**Release 1D - Instagram connector:** implement and validate Instagram publishing and eligible analytics through the official Meta API. Do not begin until account eligibility, required permissions, media requirements, and app-review/access requirements have been checked against current official docs.

## 6. Explicit v1 non-goals

- TikTok or Facebook Reels publishing.
- Competitor scraping or automated copying of competitor content.
- Visual no-code workflow builder.
- Full nonlinear video editing suite.
- Team invitations, enterprise SSO, and fine-grained organization hierarchies.
- Subscription billing, marketplace, affiliate system, or creator monetization management.
- Automatic thumbnail/title A/B test orchestration.
- Automatic modification of channel strategy without user approval.
- Custom model training or fine-tuning.
- Automated comments/replies/DMs.
- Arbitrary browser automation to publish on behalf of users.
- Claims that content is guaranteed unique, viral, perfect, or policy-compliant solely because an AI score passes.

## 7. Definition of v1 success

The first release is successful when a real channel configuration can produce a real generated vertical video through approved provider calls, persist all source assets and cost records, pass deterministic media validation, enter a human review state, and be manually approved. The approved video can then be uploaded to the connected YouTube account through the official API after an explicit publish action, with the returned platform ID and status verified and stored. A subsequent analytics job can retrieve at least one currently supported metric for that video/channel when permissions and API availability permit.

A demo made entirely from hardcoded responses, fake provider implementations, mocked successful uploads, or fabricated analytics does **not** satisfy this definition.

## 8. Change policy

The goal is to decide the v1 feature set early and prevent surprise scope. New ideas go into `docs/CHANGE_CONTROL.md` as proposals. A proposal is not part of the product until the owner approves it and the Core Architect/Reviewer records a decision. Bugs, security fixes, API compatibility changes, and necessary correctness work are not treated as feature creep, but must still be logged.
