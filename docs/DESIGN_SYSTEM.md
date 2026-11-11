# ReelForge Design System
**Version:** 1.1 (M21 review candidate)  
**Owner:** Product / Design  
**Applies to:** M21-M30 core product UI; M31-M34 extensions inherit the same system.

> Status: owner approved the M21 representative design direction on 2026-11-11. Component implementation and accessibility evidence remain subject to independent Core review; this document does not declare M21 integrated.

## 1. Product and brand character

ReelForge is a creator's production studio: it helps people move from an idea to a finished, reviewed, published short-form video. The interface should feel like a serious creative tool with the clarity of a well-run production desk.

**Brand attributes**
- **Editorial:** strong hierarchy, purposeful typography, considered whitespace.
- **Craft-led:** visible timelines, previews, status, and production detail; avoid decorative UI that obscures the work.
- **Confident:** restrained colour, decisive actions, clear system feedback.
- **Human-controlled:** AI-assisted work is inspectable, editable, reviewable, and never presented as magic or as an autonomous promise.
- **Distinctive:** warm studio surfaces, ink-dark navigation, and a signature signal-orange accent.

**Design concept: “The Creator's Control Room.”** Pair a calm, warm working canvas with a deep graphite frame and a vivid orange action signal. Use imagery and video previews as the expressive colour; keep the application chrome disciplined.

**Do not use:** default purple/blue AI gradients, random neon glows, glassmorphism as a default surface, excessive rounded cards, decorative charts, emoji as core icons, or generic SaaS dashboard templates.

## 2. Colour foundations

The CSS source of truth is `apps/web/styles/design-tokens.css`. Components must consume semantic tokens, not scatter raw hex values through feature styles.

### Core palette

| Token | Value | Purpose |
|---|---:|---|
| Studio Ink | `#17191C` | Primary dark frame / navigation |
| Deep Ink | `#101214` | Deep surfaces |
| Warm Canvas | `#F5F2EC` | Main light working surface |
| Paper | `#FFFEFB` | Elevated light surface |
| Slate | `#62676D` | Secondary text / neutral controls |
| Signal Orange | `#E85B2A` | Primary action and brand signal |
| Signal Hover | `#C9471D` | Hover / pressed emphasis |
| Muted Sage | `#647B68` | Calm success accent |
| Caution Ochre | `#A66A16` | Warning accent |
| Alert Red | `#B93832` | Destructive/error accent |
| Studio Blue | `#315D78` | Informational accent, not primary brand |

### Semantic usage

- `--rf-bg`: page canvas; `--rf-surface`: default panel; `--rf-surface-raised`: popover/dialog.
- `--rf-text`: primary text; `--rf-text-muted`: secondary text; `--rf-text-subtle`: tertiary metadata.
- `--rf-border`: standard separators; `--rf-border-strong`: focused/important boundaries.
- `--rf-accent`: primary action only; use sparingly so it remains recognizable.\n- `--rf-on-accent`: the semantic foreground for default primary accents (dark ink in light and dark themes); `--rf-on-accent-hover`: the foreground for the hover accent (light paper in the light theme, dark ink in the dark theme). Never use hardcoded white text on Signal Orange.
- `--rf-success`, `--rf-warning`, `--rf-danger`, `--rf-info`: status meaning, never decoration.

Colour must never be the only way to communicate status. Pair status colour with text, an icon, or another non-colour cue. Verify text and control contrast against WCAG 2.2 AA before release. The token values are design starting points; accessibility checks take precedence over visual preference.

## 3. Typography

Use a modern, highly legible sans-serif for interface text and a restrained mono face for technical metadata. Prefer self-hosted/licensed font assets. Until a font is selected and committed, use the system fallbacks in the token file.

- Display / page title: compact, confident, medium-to-semibold weight; avoid oversized marketing headlines inside the product.
- Section heading: clear hierarchy; sentence case.
- Body: comfortable reading size and line-height; default 14–16px depending on density.
- Labels: concise, medium weight; never rely on tiny low-contrast text.
- Metadata / IDs / timestamps / code: tabular or monospace numerals where useful.
- Avoid using more than two type families or three weights on a screen.

## 4. Layout, spacing and shape

- Use the 4px spacing scale; compose layouts from the named spacing tokens.
- Prefer clear alignment and whitespace over nested card stacks.
- Use a persistent application shell: navigation, contextual page header, content canvas, and optional inspector/detail rail. The inspector remains accessible via a modal disclosure at widths below 1200px; do not hide meaningful context without an alternative.
- Use a responsive content width; long-form editors and tables should not stretch edge-to-edge on wide displays.
- Use 8px as the default control radius, 12px for larger panels, and full pills only for compact status/segmented controls where appropriate.
- Borders define structure; shadows are reserved for overlays and meaningful elevation.
- Keep a consistent page rhythm: title and description, primary action area, main work surface, supporting context.

## 5. Core component language

Build shared components before feature-specific variants. Every component needs documented variants, states, keyboard behaviour, and responsive behaviour.

| Component | Required variants / behaviour |
|---|---|
| Button | Primary, secondary, tertiary/ghost, destructive; default, hover, focus-visible, active, disabled, loading |
| Icon button | Tooltip/accessible name; visible focus ring; minimum 44px target where practical |
| Text field / textarea | Label, hint, error, disabled, read-only; never use placeholder as the only label |
| Select / combobox | Keyboard navigation, selected state, empty state, clear/error handling |
| Tabs / segmented control | Selected state, keyboard support, responsive overflow |
| Badge / status | Semantic status with text; neutral default |
| Card / panel | Flat default, raised only when hierarchy requires it |
| Dialog / drawer | Focus trap, escape handling where safe, labelled title, predictable close |
| Toast / inline alert | Success, info, warning, error; actionable recovery where relevant |
| Data table | Clear column hierarchy, row actions, empty/loading/error states, responsive fallback |
| Media preview | Stable aspect ratio, playback controls, caption/metadata, loading and failure state |
| Timeline / storyboard | Consistent track/scene spacing, selection and focus state, zoom/scroll affordances |
| Progress / job status | Named stage, progress where measurable, indeterminate state otherwise, recoverable failure |

Use one icon family consistently (Lucide is the default proposal); do not mix emoji, filled glyphs, and unrelated icon packs. Icons that convey an action need an accessible name.

## 6. Interaction principles

1. **Show the next useful action.** Each screen has one clear primary action; secondary actions do not compete visually.
2. **Make state legible.** Distinguish draft, queued, processing, needs review, approved, scheduled, published, failed, and unavailable states.
3. **Explain uncertainty.** Never imply that a provider is connected, generation is running, or publishing succeeded unless the backend confirms it.
4. **Protect creator work.** Confirm destructive actions; preserve edits; communicate unsaved changes; make retries explicit.
5. **Keep AI controllable.** Show inputs, generated outputs, editable fields, provenance where applicable, and human approval checkpoints.
6. **Use motion with purpose.** Short, subtle transitions for state change; respect reduced-motion preferences; no looping decorative motion.
7. **Avoid surprise.** Actions should have predictable placement and clear feedback; no hidden critical actions on hover only.

## 7. Required screen states

Every data-backed feature must design and implement:
- Initial/loading and background-refresh states.
- Empty state with a useful next step.
- Success/complete state.
- Validation and recoverable error state.
- Permission-denied / unavailable / not-configured state where relevant.
- Offline or interrupted state where relevant.
- Destructive confirmation and unsaved-changes state where relevant.

Do not show fake sample metrics or pretend integrations in production UI. Fixture/demo data must be labelled.

## 8. Responsive behaviour

Design mobile-first constraints even if desktop is the primary production environment.

- **Small (<640px):** single-column work surfaces; navigation becomes a compact menu; tables become stacked rows or controlled horizontal scroll; primary actions remain reachable.
- **Medium (640-1023px):** compact navigation; inspector panels become drawers; two-column layouts only where content remains readable.
- **Large (>=1024px):** full app shell, optional inspector rail, dense production workflows.
- **Wide (>=1440px):** cap content width and preserve readable line lengths; do not simply expand every panel.

No horizontal page overflow at supported breakpoints. Preserve keyboard access and logical reading order when layouts rearrange.

## 9. Accessibility baseline

Target WCAG 2.2 AA:
- Semantic HTML and correctly associated labels.
- Full keyboard operation and visible `:focus-visible` treatment.
- Sufficient contrast for text, controls, borders, and focus indicators.
- Minimum 24x24 CSS px target size (WCAG 2.2 AA), with 44x44 preferred for primary touch controls.
- Respect `prefers-reduced-motion`.
- Announce async status updates appropriately without flooding screen readers.
- Do not communicate meaning through colour alone.
- Dialogs, menus, tabs, and custom controls must follow expected keyboard patterns.

## 10. Content and voice

Use concise, calm, direct language. Prefer verbs that describe the actual action: “Generate preview”, “Request review”, “Schedule post”. Avoid hype such as “magic”, “revolutionary”, “effortless”, or claims that the system is autonomous. Distinguish “Not connected”, “Not configured”, “Queued”, and “Failed”; they are not interchangeable.

## 11. Feature-area expression

All feature areas inherit the same shell, tokens, controls, and status language. Their work surfaces may differ:
- Ideas/scripts: editorial reading and writing canvas.
- Storyboard/generation: visual media workspace with inspectable scene-level progress.
- Review: comparison, evidence, comments, and explicit approval actions.
- Publishing/calendar: scheduling-first layouts and clear account/platform state.
- Analytics: restrained data visualisation with definitions and time ranges.
- Operations/usage: dense but legible tables, filters, audit context, and budget warnings.

Do not create a new colour palette or component language for an individual module.

## 12. Governance and change control

- This document and `apps/web/styles/design-tokens.css` are the shared design references.
- New tokens require a semantic name, rationale, and usage guidance. Avoid one-off values.
- New components require accessibility, responsive, empty/loading/error, and interaction-state definitions.
- Feature modules consume the shared system; they do not fork it.
- Design changes that affect the whole product require review in M21 and updates here.
- Before implementation, owner-review wireframes and high-fidelity direction for the app shell and representative key screens.
- Update this document when approved decisions change; do not let code and documentation silently diverge.

## 13. M21 acceptance checklist

- [ ] Owner-approved brand direction and representative screen designs.
- [ ] Token file is imported by the app and used as the styling source of truth.
- [ ] Shared app shell and core component primitives are implemented.
- [ ] Typography, responsive breakpoints, spacing, surfaces, and semantic states are documented.
- [ ] Keyboard, focus, reduced-motion, and contrast checks are evidenced.
- [ ] Loading, empty, error, success, unavailable, and not-configured patterns exist.
- [ ] Feature modules are explicitly required to reuse the shared system.
- [ ] No generic AI dashboard styling or unverified provider claims.
