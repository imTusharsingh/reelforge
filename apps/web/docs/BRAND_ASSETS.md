# ReelForge brand assets — M21 proposal

The proposed **Forge / Play R** symbol combines an R-shaped production mark with a restrained signal-orange play wedge. It is an original, flat vector direction for owner review, not a final trademark or originality clearance.

- `public/brand/reelforge-mark.svg`: light-background compact icon (64x64 viewBox).
- `public/brand/reelforge-mark-inverse.svg`: graphite-background compact icon.
- `components/brand-logo.tsx`: shared wordmark/compact component; accessible name is ReelForge.
- `app/globals.css`: imports design-system tokens and applies the mark in a responsive header.

The wordmark uses system typography until the brand font is approved. Do not rasterize the logo for normal UI use. Preserve aspect ratio and clear space; do not apply gradients, glows, or independent feature-area colours. The orange is the design-system signal orange (#E85B2A); graphite is #17191C; warm canvas is #F5F2EC.

## Review before approval

Check the mark at 16, 24, 32, and 44 CSS pixels; verify dark/light contrast, desktop and mobile breakpoints, assistive-technology announcement, and trademark clearance. Run repository lint/typecheck/build. This proposal does not claim M21 is complete or production ready.
