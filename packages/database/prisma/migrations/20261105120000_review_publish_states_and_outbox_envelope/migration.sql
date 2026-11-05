CREATE TYPE "PublishStatus" AS ENUM (
  'DRAFT',
  'SCHEDULED',
  'PREFLIGHT',
  'UPLOADING',
  'REMOTE_PROCESSING',
  'PUBLISHED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
  'CANCELED',
  'RECONCILIATION_REQUIRED'
);

CREATE TYPE "WorkflowState" AS ENUM (
  'CREATED',
  'QUEUED',
  'RUNNING',
  'WAITING_APPROVAL',
  'SUCCEEDED',
  'PAUSED',
  'RETRY_WAIT',
  'FAILED',
  'CANCELED'
);

ALTER TABLE "posts"
  ALTER COLUMN "status" TYPE "PublishStatus" USING ("status"::"PublishStatus");

ALTER TABLE "workflow_runs"
  ALTER COLUMN "state" TYPE "WorkflowState" USING ("state"::"WorkflowState");

ALTER TABLE "outbox_events"
  ADD COLUMN "channel_id" UUID,
  ADD COLUMN "causation_id" UUID,
  ADD COLUMN "aggregate_type" TEXT,
  ADD COLUMN "aggregate_id" UUID;

UPDATE "outbox_events"
SET "aggregate_type" = 'Post',
    "aggregate_id" = ("payload" ->> 'postId')::UUID
WHERE "event_type" IN ('PostPublished', 'PublishFailed');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "outbox_events"
    WHERE "aggregate_type" IS NULL OR "aggregate_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot migrate outbox rows without a known aggregate identity';
  END IF;
END $$;

ALTER TABLE "outbox_events"
  ALTER COLUMN "aggregate_type" SET NOT NULL,
  ALTER COLUMN "aggregate_id" SET NOT NULL;
