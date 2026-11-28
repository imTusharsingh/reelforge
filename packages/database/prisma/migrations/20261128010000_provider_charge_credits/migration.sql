ALTER TABLE usage_adjustments ADD COLUMN provider_request_id UUID,
    ADD CONSTRAINT usage_adjustments_workspace_id_provider_request_id_fkey
      FOREIGN KEY (workspace_id, provider_request_id)
      REFERENCES provider_requests (workspace_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT usage_adjustments_provider_credit CHECK (provider_request_id IS NULL OR
      (kind = 'CREDIT' AND operation_key IS NOT NULL AND text_attempt_id IS NULL));
CREATE INDEX usage_adjustments_workspace_id_provider_request_id_idx
    ON usage_adjustments (workspace_id, provider_request_id);
