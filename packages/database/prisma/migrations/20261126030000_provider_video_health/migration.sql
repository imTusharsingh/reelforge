CREATE TABLE "provider_video_health" (
  "workspace_id" UUID NOT NULL REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "provider_id" TEXT NOT NULL,
  "calls" INTEGER NOT NULL,
  "accepted" INTEGER NOT NULL,
  "failures" INTEGER NOT NULL,
  "open_until" TIMESTAMPTZ(6),
  CONSTRAINT "provider_video_health_pkey" PRIMARY KEY ("workspace_id", "provider_id"),
  CONSTRAINT "provider_video_health_counters_check"
    CHECK ("calls" >= 0 AND "accepted" BETWEEN 0 AND "calls" AND "failures" BETWEEN 0 AND "calls")
);
