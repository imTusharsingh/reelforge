-- PostgreSQL requires the enum addition to commit before its first use.
BEGIN;
ALTER TYPE "UsageCategory" ADD VALUE IF NOT EXISTS 'MUSIC';
COMMIT;

-- Correct only reservations linked to the exact paid VideoRun attempt.
UPDATE usage_reservations AS reservation
SET category = (CASE
  WHEN step.key LIKE 'media:text:%' THEN 'LLM'
  WHEN step.key = 'media:narration' THEN 'TTS'
  WHEN step.key = 'media:music' THEN 'MUSIC'
  ELSE 'IMAGE_MEDIA'
END)::"UsageCategory"
FROM video_run_steps AS step
WHERE reservation.workspace_id = step.workspace_id
  AND reservation.correlation_id = step.id
  AND reservation.idempotency_key = 'm08:' || step.idempotency_key
  AND reservation.category = 'VIDEO_MEDIA'
  AND (step.key LIKE 'media:text:%' OR step.key LIKE 'media:keyframe:%'
    OR step.key LIKE 'media:reference:%' OR step.key IN ('media:narration','media:music'));
