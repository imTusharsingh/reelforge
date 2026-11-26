-- Preserve admission bounds while allowing an invoiced overage to be settled in full.
ALTER TABLE budget_envelopes ADD COLUMN overage_minor integer NOT NULL DEFAULT 0,
  DROP CONSTRAINT budget_envelope_bounds;
ALTER TABLE budget_envelopes ADD CONSTRAINT budget_envelope_bounds CHECK
(currency = 'USD' AND target_minor >= 0 AND target_minor <= hard_cap_minor AND hard_cap_minor > 0
 AND reserved_minor >= 0 AND spent_minor >= overage_minor AND overage_minor >= 0
 AND reserved_minor::bigint + spent_minor - overage_minor <= hard_cap_minor
 AND base_estimate_minor >= 0 AND reshoot_reserve_minor >= 0 AND base_estimate_minor + reshoot_reserve_minor <= hard_cap_minor);

-- Existing VideoRun reservations are denominated in USD. Repair the active attempt's
-- fallback period and any unpriced unknown created by an older recovery worker.
UPDATE provider_requests pr
SET created_at = ur.created_at,
    estimated_cost = COALESCE(pr.estimated_cost, ur.amount_minor / 100.0),
    currency = COALESCE(pr.currency, ur.currency)
FROM usage_reservations ur JOIN video_run_steps s
  ON s.workspace_id = ur.workspace_id AND s.id = ur.correlation_id
 AND ur.idempotency_key = 'm08:' || s.idempotency_key
WHERE pr.workspace_id = ur.workspace_id AND pr.correlation_id = ur.correlation_id
  AND ur.currency = 'USD' AND pr.error_code IN ('VIDEO_RUN_OUTCOME_UNKNOWN','VIDEO_RUN_DISPATCHING','PENDING');
