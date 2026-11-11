# M21 Frontend Audit — T01

**Date:** 2026-11-11 (IST)  
**Base:** `main` at `5463226fc1497c1c427aee5c8fd2b00f199339d6` (ancestry: PR #38 → PR #40 → PR #39).  
**Stage:** design review only; no production shell/component implementation has been authorized.

## Existing frontend inventory

| Item | State | Evidence / gap |
|---|---|---|
| Next.js App Router root layout | EXISTS | `apps/web/app/layout.tsx`, title and favicon metadata |
| Single brand-preview landing route | EXISTS | `apps/web/app/page.tsx`, static heading, four mark previews; not a functional workspace |
| Shared design token CSS | EXISTS | `apps/web/styles/design-tokens.css`, imported via `app/globals.css`, semantic light/dark tokens |
| Responsive brand header | NEEDS REFINEMENT | `app/globals.css` hides wordmark below 640px, but no application navigation, app shell, inspector or mobile menu |
| Full and compact light/inverse brand marks | EXISTS | `apps/web/components/brand-logo.tsx` and `public/brand/reelforge-mark{,-inverse}.svg` from PR #39 |
| Brand asset usage guidance | EXISTS | `apps/web/docs/BRAND_ASSETS.md`, still explicitly proposed |
| Design-system governance | EXISTS | `docs/DESIGN_SYSTEM.md`, status **proposed**, no owner-approved screen direction |
| Shared UI primitives | MISSING | No Button, Field, Alert, Panel, Tabs, Drawer or state primitive library in `apps/web/components/` |
| Keyboard/focus and responsive evidence | MISSING | Global focus style exists, but no audited nav/menu/focus/contrast and 320–1440px visual matrix |
| Web component/visual regression tests | MISSING | No web-specific component tests or screenshot baselines identified in inspected frontend tree |
| Capability-driven feature views | OUT OF SCOPE | M22–M29, not part of this foundation PR |

## Risks and review concerns

1. The existing `BrandLogo` uses an image with empty alt and a labelled wrapper; screen-reader announcement and compact 16/24/32/44px legibility require browser/assistive verification.
2. Responsive header is a branding strip only. It must not be described as a finished app shell.
3. Global `html` background/focus token rules exist; future components must use semantic tokens consistently and avoid duplicate palettes.
4. Proposed design direction and existing logo are **not** evidence of owner approval for screens.
5. No actual responsive screenshot, contrast scan, or interaction test was run in this session; all are pending after approval.

## Proposed implementation order (after owner approval only)

T04: semantic application shell, accessible mobile navigation, responsive inspector pattern, and a small typed component library; T05: keyboard/state/contrast/responsive matrix; T06: component tests and repeatable screenshot convention. No runtime fake integrations, auth pages, publishing calendar, or feature module screens.

## Explicit non-scope

No changes to `apps/api/**`, worker, database, contracts, schemas, migrations, CI, root dependencies, or M22–M34 modules. No new icon/font/framework package without written Core approval.
