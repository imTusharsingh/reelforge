# ReelForge shared component guide (M21)

**Scope:** common frontend foundation, not M22–M29 feature implementation. **Owner direction approved in chat on 2026-11-11** for the four proposed M21 screens; this is not independent Core approval.

## Source and reuse

- `apps/web/styles/design-tokens.css`: semantic color, spacing, typography, motion and shape.
- `apps/web/app/globals.css`: shared styles and breakpoints; avoid module-specific token forks.
- `apps/web/components/brand-logo.tsx`: original M21 compact/full brand SVG from PR #39, unchanged.
- `apps/web/components/app-shell.tsx`: responsive navigation frame, skip link, optional context rail and native modal mobile drawer.
- `apps/web/components/ui/primitives.tsx`: reusable Button, IconButton, Field, TextAreaField, SelectField, Badge, Panel, StateMessage, Alert.
- `apps/web/components/ui/tabs.tsx`: controlled internal tab selection with arrow/Home/End keyboard support.

Use semantic HTML. Text inputs require an explicit unique `id` and `label`. Error text uses `aria-describedby` and `aria-invalid`; do not substitute a placeholder for a label. Buttons default to `type="button"` to avoid accidental form submissions; use `type="submit"` explicitly in real forms. A loading button is disabled and uses `aria-busy`. IconButton requires a visible-to-AT `label`; decorative content is hidden.

`StateMessage` supports `loading`, `empty`, `error`, `success`, `forbidden`, and `unavailable`. Use state-specific explanatory text, never fabricated success; `error` uses a live alert role and non-error states use `status`. `Alert` supports information/success/warning/danger. Do not rely on color alone.

`Tabs` uses semantic tablist/tab/tabpanel roles. Arrow Left/Right and Home/End move focus and activate a tab, Tab moves to the selected panel. Provide stable unique item IDs and concise labels. The tablist scrolls horizontally on narrow screens.

At widths below 1200px, the context rail remains reachable through **View context** in the header: the control opens a right-aligned native modal `<dialog>` and the close control/ Escape return focus to the trigger. The desktop rail remains visible at >=1200px. Native dialog focus containment is subject to browser verification.

Mobile navigation uses native `dialog.showModal()` for modal background and focus containment. Escape closes the dialog by browser default; the close button and `onClose` return focus to the Menu trigger. For semantic accuracy, future feature destinations are rendered as **non-clickable planned labels**; they are not navigable links or working routes.

## Layout and interaction

- 320–1023px: dark mobile header, visible 44px Menu control, compact mark below 640px, single-column work surface.
- 1024px+: dark sidebar, content grid and optional inspector; inspector is suppressed below 1200px.
- Status classes and margins use shared tokens. Shared status fills derive from semantic tokens. Primary action text uses `--rf-on-accent` and hover text uses `--rf-on-accent-hover` in both light and dark theme.
- Native buttons/select/textarea/inputs retain keyboard behavior; `:focus-visible` comes from design tokens. Motion respects global `prefers-reduced-motion`.
- Dialog and tabs require actual keyboard/browser testing before final acceptance; component static markup tests cannot prove focus behavior or visual contrast.

## Future module implementation rules

M22–M30 consume the shell/primitives; do not create separate palettes, custom navigation systems, fake provider activity or runtime fixture metrics. Backend authority/tenant enforcement remains in API modules, never client-side-only styling.

## Verification snapshot

See M21 `STATUS.md` and PR CI for actual test outcomes; no locally verified browser screenshots, screen reader, 320–1440px overflow checks or automated screenshot comparisons were performed in this implementation environment. These must be completed before M21 is considered accepted.
