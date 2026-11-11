# M21 representative screen review

**Not a runtime route or feature.** These SVGs are editable source mockups, not screenshots of a functioning UI.

| Asset | Artboard | Purpose |
|---|---|---|
| desktop-shell.svg | 1440×900 | Full navigation, editorial work surface, context rail, status language |
| mobile-shell.svg | 390×844 | Compact brand/header, menu trigger, single-column work surface |
| empty-state.svg | 1440×900 | Useful first-run state; no fabricated content |
| unavailable-state.svg | 1440×900 | Plain explanation and recovery direction without a fake provider state |

## Owner evaluation checklist

1. Does the editorial framing feel distinctive, appropriately serious and consistent with the original ReelForge mark?
2. Is the dark frame proportion/spacing right, or should navigation be narrower/lighter?
3. Is the orange primary action restrained enough? Do the state colors still read as meaningful text?
4. Is the 390px header, menu trigger and single-column composition understandable?
5. Is the context rail useful, or should it be collapsed by default?
6. Are the empty and unavailable messages clear, actionable and honest about current capabilities?

## Proposed interaction specification (not yet coded)

- Desktop: navigation sidebar visible from 1024px upward; optional detail rail; clear current section.
- Mobile: 44px+ menu trigger, Esc closes, focus moves into panel then returns to trigger on close, background content inert while open. No custom animation under reduced-motion.
- 320/375/640/768/1024/1440px: no page-wide overflow; inspector becomes a controlled drawer below desktop.
- The SVGs illustrate appearance only; keyboard flow and contrast verification require actual implementation and browser testing after owner approval.

## Approval record

**Pending.** Record the project owner's explicit approval, timestamp, approved assets and revisions in `DESIGN_BRIEF.md` and `STATUS.md` before T04–T06.
