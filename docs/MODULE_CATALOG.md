# Module Catalog and Work-Package Map

Each module is one independently assignable block. Each block gets one coding-editor session, one isolated Git branch/worktree, one status file, and one reviewer decision. The detailed scope and tasks are in `work-packages/Mxx-*/WORK_PACKAGE.md`.

| ID | Module | Primary dependency | Outcome |
|---|---|---|---|
| M00 | Repository Governance & Shared Contracts | None; first block. | Establish repository rules, engineering quality gates, shared contracts, initial schema, CI, and bot coordination. |
| M01 | Identity & Workspace | M00. | Authenticate users and enforce workspace-scoped access for all user-owned data. |
| M02 | Channel & Brand Management | M01, M00. | Manage multiple independently configured channels within a workspace. |
| M03 | Genres, Formats & Content Series | M02, M00. | Provide configurable genre templates and recurring content series without hardcoded niche logic. |
| M04 | Characters & Asset Library | M01, M02, M00. | Maintain reusable characters and licensed media assets with versioned references. |
| M05 | Configuration & Prompt Engine | M02, M03, M04, M00. | Resolve hierarchical configuration and compile versioned prompts deterministically. |
| M06 | Idea & Topic Registry | M02, M03, M05, M08 (LLM port), M00. | Generate, track, approve, and de-duplicate content ideas. |
| M07 | Script & Storyboard | M03, M04, M05, M06, M08, M00. | Convert an approved idea into a structured script and scene plan. |
| M08 | AI Provider Registry & Cost Ledger | M00; consumed by M06/M07/M09. | Expose provider-neutral AI capabilities and record real provider use and costs. |
| M09 | Scene Media Generation | M04, M05, M07, M08, M16 contracts, M00. | Generate image/video/voice assets for each storyboard scene. |
| M10 | Video Composition & Export | M04, M07, M09, M08 (cost if applicable), M00. | Compose generated scene assets into a validated vertical video. |
| M11 | Quality Assurance & Approval | M03, M04, M05, M07, M10, M00. | Run hard technical/policy checks and manage human review. |
| M12 | Social Accounts & Platform Adapters | M01, M02, M00. | Connect social accounts securely and implement platform-specific API adapters. |
| M13 | Publishing Calendar & Delivery | M02, M10, M11, M12, M16, M18, M00. | Schedule and publish approved content through connected platform adapters. |
| M14 | Analytics Collection & Metric Store | M12, M13, M01, M00. | Collect and normalize available platform metrics with provenance and timestamps. |
| M15 | Performance Intelligence & Learning | M03, M06, M07, M13, M14, M05, M00. | Translate verified historical metrics into explainable recommendations and controlled experiments. |
| M16 | Workflow Orchestration & Scheduler | M00 contracts; integrated with all modules incrementally. | Coordinate durable jobs, schedules, dependencies, pause/resume, retries, and run history. |
| M17 | Notifications & Reporting | M01, M02, M13, M14, M15, M16, M00. | Deliver useful event-based notifications and scheduled channel reports. |
| M18 | Usage, Budget & Billing Foundation | M01, M02, M08, M09, M10, M13, M16, M00. | Control provider spending and expose transparent per-channel usage. |
| M19 | Admin, Security, Audit & Observability | M00 and all modules incrementally. | Provide operational safety, audit history, health checks, and diagnostic visibility. |
| M20 | Core Integration & Release Gate | All modules as they become review-ready. | Core Architect/Reviewer only: integrate modules, verify cross-module behavior, and release. |

| M21 | Frontend Foundation, Brand Identity & Design System | M00; existing frontend baseline. | Establish a human-led, approved visual system and reusable frontend foundation. |
| M22 | Authentication, Workspace & Onboarding UI | M01, M21. | Provide the entry, workspace and first-run experience. |
| M23 | Channel, Brand & Content Configuration UI | M02-M05, M21-M22. | Expose channel and content configuration through the product UI. |
| M24 | Ideas, Scripts & Storyboard Workspace | M06-M07, M21, M23. | Provide the creator planning and storyboard workspace. |
| M25 | Generation Studio & Video Production UI | M08-M10, M16, M18, M21, M24. | Expose generation, scene management, preview and export. |
| M26 | Quality Review, Approval & Regeneration | M11, M21, M24-M25. | Provide review and approval before publishing. |
| M27 | Social Accounts, Publishing & Content Calendar | M12-M13, M21, M25-M26. | Expose supported account connections and publishing workflows. |
| M28 | Analytics, Insights & Recommendations | M14-M15, M21, M27. | Present verified performance and explainable recommendations. |
| M29 | Workflow Monitoring, Notifications & Usage Dashboard | M16-M18, M21. | Expose jobs, notifications, usage and budgets. |
| M30 | Production Hardening & Launch Readiness | M00-M29 as applicable. | Verify production infrastructure, security, operations and release readiness. |
| M31 | Subscription & SaaS Billing | M18, M30; explicit commercial approval. | Add deferred subscription and payment collection. |
| M32 | Team Collaboration & Shared Workspaces | M01-M02, M21. | Enable multi-user collaboration with workspace-safe permissions. |
| M33 | Research, Trends & Source Verification | M05-M07, M21. | Add traceable research and source-aware content planning. |
| M34 | Localization & Multi-Platform Content Outputs | M07, M09-M10, M12-M13, M21. | Support localized and platform-specific content variants. |

## Dependency order (high level)

```text
M00
 ├─ M01 ─ M02 ─ M03 ─ M06 ─ M07 ─ M09 ─ M10 ─ M11 ─ M13 ─ M14 ─ M15
 │         ├─ M04 ─────────────┘      │                 │
 │         ├─ M05 ───────────────────┘                 │
 │         └─ M12 ────────────────────────────────┘    │
 ├─ M08 ───────────────┬──────────────┘                │
 ├─ M16 (skeleton early; integrated across all) ───────┘
 ├─ M17 (event consumers)
 ├─ M18 (budget/cost guardrails)
 └─ M19 (cross-cutting operations)
        M20 Core Integration & Release Gate
```

The diagram is intentionally simplified. The exact dependencies and accepted contracts are declared in each work package.

## Parallelization rules

- M01, M04, M08 interface design, M03, and M05 can begin after M00 contracts are frozen, subject to stated dependencies.
- M06 and M07 can develop against approved typed ports while provider adapter implementation proceeds separately.
- M09 must not begin real media generation until M04/M05/M07/M08 contracts are approved.
- M12 can implement YouTube OAuth and connector independently of video generation, but publishing integration waits for M10/M11/M13 contracts.
- M14 can define metric contracts while M12/M13 progress; it cannot claim metrics are supported until verified.
- M16 begins with job/event/state-machine skeleton early, then integrates approved module handlers incrementally.
- M20 integration work is sequential for shared contracts and schema. Do not merge competing changes to shared files in parallel.
