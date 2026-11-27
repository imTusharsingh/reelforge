-- Additive storage only. Legacy admissions and their postings are imported separately after drain.
CREATE TABLE "text_attempt_evidence" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "nonce" TEXT,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "text_attempt_evidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "text_attempt_evidence_sequence_positive" CHECK ("sequence" > 0),
    CONSTRAINT "text_attempt_evidence_workspace_id_attempt_id_fkey" FOREIGN KEY ("workspace_id", "attempt_id")
        REFERENCES "video_run_steps" ("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "text_attempt_evidence_attempt_id_sequence_key"
    ON "text_attempt_evidence" ("attempt_id", "sequence");
CREATE UNIQUE INDEX "text_attempt_evidence_attempt_id_event_key_key"
    ON "text_attempt_evidence" ("attempt_id", "event_key");
CREATE UNIQUE INDEX "text_attempt_evidence_one_arm_per_attempt"
    ON "text_attempt_evidence" ("attempt_id") WHERE "kind" = 'ARMED';
CREATE INDEX "text_attempt_evidence_workspace_id_attempt_id_idx"
    ON "text_attempt_evidence" ("workspace_id", "attempt_id");

-- Append-only while the owning attempt exists; allow tenant deletion to cascade.
CREATE FUNCTION enforce_text_attempt_evidence_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM "video_run_steps"
        WHERE "workspace_id" = OLD."workspace_id" AND "id" = OLD."attempt_id"
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'text attempt evidence is append-only';
END;
$$;
CREATE TRIGGER "text_attempt_evidence_append_only"
    BEFORE UPDATE OR DELETE ON "text_attempt_evidence"
    FOR EACH ROW EXECUTE FUNCTION enforce_text_attempt_evidence_append_only();

CREATE TABLE "text_attempt_projections" (
    "workspace_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "applied_sequence" INTEGER NOT NULL,
    "reserved_minor" INTEGER NOT NULL,
    "gross_minor" INTEGER NOT NULL,
    "net_minor" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "text_attempt_projections_pkey" PRIMARY KEY ("workspace_id", "attempt_id"),
    CONSTRAINT "text_attempt_projections_money_nonnegative" CHECK (
        "applied_sequence" >= 0 AND "reserved_minor" >= 0 AND "gross_minor" >= "net_minor"
        AND "net_minor" >= 0
    ),
    CONSTRAINT "text_attempt_projections_workspace_id_attempt_id_fkey" FOREIGN KEY ("workspace_id", "attempt_id")
        REFERENCES "video_run_steps" ("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "usage_adjustments" ADD COLUMN "text_attempt_id" UUID,
    ADD COLUMN "operation_key" TEXT;
ALTER TABLE "usage_adjustments" ADD CONSTRAINT "usage_adjustments_workspace_id_text_attempt_id_fkey"
    FOREIGN KEY ("workspace_id", "text_attempt_id")
    REFERENCES "video_run_steps" ("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "usage_adjustments_workspace_id_operation_key_key"
    ON "usage_adjustments" ("workspace_id", "operation_key");
CREATE INDEX "usage_adjustments_workspace_id_text_attempt_id_idx"
    ON "usage_adjustments" ("workspace_id", "text_attempt_id");

-- An audited import may add the two new link fields once, without changing the
-- amount, original accounting period, actor or any other historical field.
CREATE FUNCTION enforce_usage_adjustment_text_link() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE'
        AND OLD.text_attempt_id IS NULL AND OLD.operation_key IS NULL
        AND NEW.text_attempt_id IS NOT NULL AND NEW.operation_key IS NOT NULL
        AND (to_jsonb(NEW) - 'text_attempt_id' - 'operation_key')
            = (to_jsonb(OLD) - 'text_attempt_id' - 'operation_key')
        AND NEW.kind = 'CREDIT'
        AND EXISTS (
            SELECT 1 FROM "usage_audit_records" a
            JOIN "video_run_steps" s ON s.workspace_id = NEW.workspace_id
                AND s.id = NEW.text_attempt_id
            WHERE a.workspace_id = NEW.workspace_id AND a.adjustment_id = NEW.id
                AND a.correlation_id = NEW.correlation_id AND a.actor_user_id = NEW.actor_user_id
                AND a.action = 'CREDIT' AND s.key LIKE 'media:text:%'
                AND a.after #>> '{adjustment,id}' = NEW.id::text
                AND a.after #>> '{adjustment,textAttemptId}' = NEW.text_attempt_id::text
                AND a.after #>> '{adjustment,dispatchKey}' = s.idempotency_key
                AND a.after #>> '{adjustment,operationKey}' = NEW.operation_key
                AND a.after #>> '{adjustment,amountMinor}' = NEW.amount_minor::text
                AND a.after #>> '{adjustment,currency}' = NEW.currency
        )
    THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'usage_adjustments rows are append-only';
END;
$$;
CREATE OR REPLACE TRIGGER usage_adjustments_append_only
    BEFORE UPDATE OR DELETE ON "usage_adjustments"
    FOR EACH ROW EXECUTE FUNCTION enforce_usage_adjustment_text_link();
