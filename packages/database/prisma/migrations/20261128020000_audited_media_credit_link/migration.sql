-- Preserve the existing append-only and text attribution rules on every other write.
DROP TRIGGER usage_adjustments_append_only ON usage_adjustments;
CREATE TRIGGER usage_adjustments_delete BEFORE DELETE ON usage_adjustments
    FOR EACH ROW EXECUTE FUNCTION enforce_usage_adjustment_text_link();
CREATE TRIGGER usage_adjustments_text_update BEFORE UPDATE ON usage_adjustments
    FOR EACH ROW WHEN (NEW.provider_request_id IS NULL OR OLD.provider_request_id IS NOT NULL)
    EXECUTE FUNCTION enforce_usage_adjustment_text_link();

CREATE FUNCTION enforce_usage_adjustment_media_link() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.text_attempt_id IS NULL AND OLD.operation_key IS NULL
        AND NEW.kind = 'CREDIT' AND NEW.text_attempt_id IS NULL
        AND (to_jsonb(NEW) - 'provider_request_id' - 'operation_key')
            = (to_jsonb(OLD) - 'provider_request_id' - 'operation_key')
        AND EXISTS (
            SELECT FROM usage_audit_records a
            JOIN provider_requests p ON p.workspace_id = NEW.workspace_id AND p.id = NEW.provider_request_id
            WHERE a.workspace_id = NEW.workspace_id AND a.adjustment_id = NEW.id
                AND a.actor_user_id = NEW.actor_user_id AND a.correlation_id = NEW.correlation_id
                AND a.action = 'CREDIT' AND p.currency = NEW.currency
                AND p.channel_id IS NOT DISTINCT FROM NEW.channel_id
                AND a.after->'adjustment' @> jsonb_build_object('id', NEW.id,
                    'providerRequestId', p.id, 'channelId', NEW.channel_id, 'amountMinor', NEW.amount_minor,
                    'currency', NEW.currency, 'operationKey', NEW.operation_key)
                AND NOT (a.after->'adjustment' ? 'textAttemptId')
                AND NOT EXISTS (SELECT FROM usage_audit_records other WHERE other.workspace_id = a.workspace_id
                    AND other.adjustment_id = a.adjustment_id AND other.id <> a.id
                    AND (other.after->'adjustment' ?| array['textAttemptId','providerRequestId']))
        )
    THEN RETURN NEW;
    END IF;
    RAISE EXCEPTION 'usage_adjustments rows require exact audit proof for media attribution';
END;
$$;
CREATE TRIGGER usage_adjustments_media_update BEFORE UPDATE ON usage_adjustments
    FOR EACH ROW WHEN (NEW.provider_request_id IS NOT NULL AND OLD.provider_request_id IS NULL)
    EXECUTE FUNCTION enforce_usage_adjustment_media_link();
