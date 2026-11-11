# ReelForge visual regression and accessibility convention (M21)

**Initial status:** repeatable manual process; not an automated screenshot suite. No Playwright/Storybook/dependency/CI additions are authorized by M21.

## Fixture and baseline protocol

The page `/` is explicitly a foundation preview, not a creator account or connected API session. Mockup sources are in `work-packages/M21-frontend-foundation-brand-identity-and-design-system/design-review/`. Store approved **browser screenshots** only under `apps/web/docs/visual-baselines/` in a future separately reviewed change; no baseline is claimed to exist today.

Capture these viewports in a supported browser at 100% zoom: 320×720, 375×812, 390×844, 640×900, 768×1024, 1024×768, 1440×900, 1920×1080. Use descriptive names `m21-overview-<width>x<height>-light.png`, `m21-mobile-menu-390x844-light.png`, `m21-states-1440x900-light.png`. Capture the menu open, closed, tab selection states and reduced-motion setting, with no genuine account information.

## Manual acceptance walkthrough

1. At 320px width ensure no horizontal page scrollbar, no clipped controls; at 375/640/768/1024/1440 repeat and record PASS/FAIL for each.
2. At 320px, 390px, 1024px and 1199px activate **View context**, ensure the context is visible in the native modal, focus stays inside, Escape and Close both return focus to the trigger; repeat at 1200px to confirm the fixed context rail replaces the drawer.
3. Keyboard: Tab first reaches "Skip to content"; Enter moves focus to main. At 390px Tab reaches Menu; Enter opens modal; focus stays inside; Escape closes; focus returns to Menu. Repeat using Close button. A browser is required to prove this.
4. At the state tabs use ArrowRight, ArrowLeft, Home, End; ensure tab focus/selection and `aria-selected` agree; use Tab to reach the panel.
5. Inspect focus-visible and confirm contrast against WCAG 2.2 AA (normal text 4.5:1, large text 3:1, non-text UI boundaries 3:1). Record actual measured foreground/background pairs and method. No assumed passing scores.
6. Toggle reduced motion and inspect transitions. Confirm screen reader announcement for status/error and accessible mark label.
7. Refresh/close menu; no phantom navigation or fake provider action should occur.

## Change control

For every UI change: run lint/format/typecheck/test/build; reproduce the approved viewport/state screenshots; compare manually to the approved baseline, annotate diffs, record reviewer acceptance, and replace baselines **only** with written owner/Core approval. Do not silently update baselines. If screenshot automation is later approved, introduce it in a separately reviewed tooling change with deterministic fixtures and explicit CI scope.

## Evidence table

| Check | State | Reason |
|---|---|---|
| Component source-contract checks | PASS in CI run 42987191629 | Static file contracts, not DOM rendering or interaction |
| Manual 320–1920px viewport screenshots | NOT RUN | No browser-backed visual session was performed |
| Navigation and inspector dialog focus, Escape/return focus | NOT RUN | Requires real browser interaction; markup and CSS contract tests added |
| Tabs keyboard interaction | PARTIAL | Pure navigation keys tested; real browser focus still NOT RUN |
| Semantic light/dark sRGB accent contrast | TESTED IN CI | Actual semantic token pairs and CSS consumption asserted; rendered contrast and screen reader NOT RUN |
| Automated screenshot diff | NOT RUN | No screenshot tooling installed or approved |

## Static palette contrast evidence (2026-11-11)

The M21 test `apps/web/components/ui/color-contrast.test.ts` computes sRGB WCAG luminance from the committed token CSS and asserts **at least 4.5:1** for semantic primary and hover foreground/background pairs in light **and** dark themes. It also checks the component stylesheet consumes those semantic foreground tokens. These are automated **static token-pair checks only**; they cannot substitute for browser-rendered contrast, focus indicators, actual overlay opacity, and viewport verification. Mobile/dark navigation explicitly uses the light focus outline.
