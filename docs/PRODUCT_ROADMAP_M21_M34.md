# Product Roadmap - M21 to M34

**Branch:** `product/m21-m34-work-packages`  
**Date:** 2026-11-11

## Planning assumptions

- M00-M20 are treated as the intended existing foundation. The inspected `main` branch's `docs/PROJECT_STATE.md` still records M20 as NOT_STARTED; reconcile against the owner's completed work before implementation. Do not rebuild completed modules to resolve stale documentation.
- M21-M30 are the core product completion phase; M31-M34 are post-core extensions.
- SaaS subscriptions/payment collection are deferred. M18 usage and budget accounting are not subscription billing.
- Frontend design must be human-led, owner-reviewed and consistent. Do not use generic AI-generated-looking screens as the design source.

## Phase A - Core product (M21-M30)

1. M21 - Human-led frontend foundation, brand identity and shared design system.
2. M22 - Authentication, workspace and onboarding UI.
3. M23 - Channel, brand and content configuration UI.
4. M24 - Ideas, scripts and storyboard workspace.
5. M25 - Generation studio, preview and export.
6. M26 - Quality review, approval and regeneration.
7. M27 - Social accounts, publishing and calendar.
8. M28 - Analytics, insights and recommendations.
9. M29 - Workflow monitoring, notifications and usage/budget.
10. M30 - Production hardening and launch readiness.

## Phase B - Extensions (M31-M34)

- M31 - Subscription and SaaS billing (deferred pending explicit commercial approval).
- M32 - Team collaboration and shared workspaces.
- M33 - Research, trends and source verification.
- M34 - Localization and multi-platform content outputs.

## Cross-package requirements

- Backend-enforced authorization and tenant isolation.
- No provider secrets in browser code or logs.
- Durable state, recoverable errors and idempotent long-running actions.
- Accessible keyboard interactions and responsive layouts.
- Shared UI tokens/components; no module-local visual systems.
- Unit, component, contract, integration and end-to-end evidence as appropriate.
- Clearly distinguish configured capabilities from unavailable or fixture-only integrations.
- Never claim tests, provider calls or production capabilities were verified without evidence.

## UI design governance

M21 must deliver the design brief, reviewed wireframes/high-fidelity key screens, semantic tokens, component library, app shell, accessibility/responsive rules and documentation. M22-M30 consume this system. Feature screens may have workflow-specific layouts but share one visual language and interaction system.
