# Wave 0 / PR A — decision record handoff

State: IMPLEMENTED_PENDING_REVIEW. Owner assignment: pasted LOCKED v2.0 plan, 2026-11-16, M00 foundations scope; this explicitly assigns shared contracts/schema/tooling to the following PR B. No approval or integration is claimed.

Changed: docs/DECISION_LOG.md (ADR-026–028, explicit ADR-009/011/017 amendments and ADR-025 supersession), this handoff, docs/WORK_LOG.md.

Scope: provider strategy, BullMQ/Postgres VideoRun, L1/L2/L3, first-ten rule, ADR-005 and ADR-019 gates. No code, CI or PROJECT_STATE changes. Friday bugs 1–5 remain for PR B; bug 6 remains V3.

Source limitation: the linked Cursor canvas returned a Cloudflare challenge. The full owner-pasted acceptance criteria control this work; no inaccessible page detail is claimed as verified.

Verification: pinned Node 24.22.2/pnpm 12.16.1 installed in an external scratch toolchain; `pnpm install --frozen-lockfile` and `pnpm db:generate` passed. Full suite `pnpm test` passed: 93 files / 704 tests; 27 files / 215 tests skipped without DATABASE_URL. No test made live provider calls. Next: official Minu review of PR A; PR B implements foundations on a separate branch from latest main. Squash merge only after official review; implementer does not merge.
