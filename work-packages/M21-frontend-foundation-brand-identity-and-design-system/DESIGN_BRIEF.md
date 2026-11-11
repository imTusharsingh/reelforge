# M21 Design Brief — T02/T03 owner review

**Status: OWNER-APPROVED DESIGN DIRECTION / CORE IMPLEMENTATION REVIEW PENDING.** This is a design-review artifact, not a claim of an approved UI or completed M21.

**Source of truth:** `docs/DESIGN_SYSTEM.md` (Creator's Control Room, proposed) and `apps/web/styles/design-tokens.css`. Existing logo from PR #39 is preserved. There are **no new global tokens or font dependencies** in this handoff.

## Direction: The Creator's Control Room

An editorial production desk, not a generic admin dashboard. Warm Canvas `#F5F2EC` for primary work surface, graphite Studio Ink `#17191C` for navigation, restrained Signal Orange `#E85B2A` for an actual primary action. Large, purposeful headings; an explicit production stage; preview detail; deliberate whitespace and subtle 1px separators.

**Typography:** use `--rf-font-sans` and `--rf-font-mono` system fallbacks until a licensed font is explicitly approved. Heading hierarchy: compact 28–36px page heading, 18–22px section, 14–16px body, 12–13px metadata. Use existing 4px spacing scale and panel/control radii. No gradient/neon/glass effects, emoji navigation icons or decorative metrics.

**Navigation:** desktop 248–256px dark frame, persistent page identity, current section visibly selected; mobile compact top bar with explicit Menu control and a focus-managed modal navigation drawer. For this stage **all destinations are design labels only**, not functioning M22–M29 routes.

**States:** empty work surface communicates a useful next action without claiming live integrations. Unavailable/error work surface shows plain-English reason and recovery/help guidance. Success/loading/focus examples are conceptual until actual primitives are implemented after approval. Display status as text, not color alone.

**Accessibility targets:** WCAG 2.2 AA, minimum 24px targets (44px preferred), semantic landmarks, visible keyboard focus, no color-only state, 320px horizontal fit, reduced-motion respect. These are **requirements**, not tested outcomes at the design-review stage.

## Reviewable sources / exports

- `design-review/desktop-shell.svg` — 1440×900 high-fidelity desktop shell, **mockup only**.
- `design-review/mobile-shell.svg` — 390×844 high-fidelity mobile shell, **mockup only**.
- `design-review/empty-state.svg` — 1440×900 representative empty workspace **mockup only**.
- `design-review/unavailable-state.svg` — 1440×900 representative unavailable/error **mockup only**.
- `design-review/README.md` — viewport, interaction and approval inspection rubric.

The labels, progress chips and navigation in the mockups are **inert design fixtures**. No live API, connected provider, historical jobs, actual analytics or real account is represented.

## Decisions requested from project owner (hard stop)

1. Approve or revise the warm-canvas / graphite / orange shell composition and left navigation placement.
2. Approve or revise full wordmark vs compact mobile mark, readability, heading density and content rhythm.
3. Approve or revise mobile drawer behavior and optional inspector treatment.
4. Approve or revise empty and unavailable states and the proposed user-facing microcopy.

**Owner decision:** APPROVED on 2026-11-11 in the current ChatGPT conversation: "I approve the M21 representative design direction. Continue with M21 T04–T06 on the existing implementation branch, following the strict task guidelines."  
**Approval link:** Conversation approval (not a public URL); exact wording above is the record.  
**Requested revisions:** None supplied.  

This clears the **owner design checkpoint** only. Implementation still requires independent Core review and verified quality checks; no release or M21 integration is implied.
