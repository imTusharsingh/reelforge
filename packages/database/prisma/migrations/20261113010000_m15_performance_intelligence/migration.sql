-- CreateEnum
CREATE TYPE "InsightReportStatus" AS ENUM ('GENERATED', 'NOT_GENERATED', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "InsightAiStatus" AS ENUM ('GENERATED', 'NOT_CONFIGURED', 'NOT_GENERATED', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "PerformanceDimension" AS ENUM ('TOPIC', 'HOOK', 'DURATION', 'CHARACTER', 'SERIES', 'PUBLISH_TIMING');

-- CreateEnum
CREATE TYPE "PerformanceConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('DRAFT', 'RUNNING', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StrategyChangeStatus" AS ENUM ('APPROVED', 'EXPORTED');

-- CreateTable
CREATE TABLE "performance_insight_reports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "comparison_start" DATE NOT NULL,
    "comparison_end" DATE NOT NULL,
    "status" "InsightReportStatus" NOT NULL,
    "kpis" JSONB NOT NULL,
    "dimension_summaries" JSONB NOT NULL,
    "narrative" TEXT,
    "ai_status" "InsightAiStatus" NOT NULL,
    "provider_id" TEXT,
    "model_version" TEXT,
    "prompt_version" TEXT,
    "cost" DECIMAL(18,8),
    "cost_currency" TEXT,
    "limitations" JSONB NOT NULL,
    "snapshot_ids" UUID[],
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_insight_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_recommendations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "report_id" UUID,
    "rank" INTEGER NOT NULL,
    "dimension" "PerformanceDimension" NOT NULL,
    "action" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "confidence" "PerformanceConfidence" NOT NULL,
    "limitations" JSONB NOT NULL,
    "evidence_snapshot_ids" UUID[],
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PROPOSED',
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "performance_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_experiments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "dimensions" "PerformanceDimension"[],
    "design_notes" TEXT NOT NULL,
    "exposure" INTEGER,
    "outcome" JSONB,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "performance_experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_strategy_changes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "recommendation_id" UUID,
    "summary" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "evidence_snapshot_ids" UUID[],
    "status" "StrategyChangeStatus" NOT NULL DEFAULT 'APPROVED',
    "approved_by_user_id" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_strategy_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "performance_insight_reports_workspace_id_id_key" ON "performance_insight_reports"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "performance_insight_reports_workspace_id_channel_id_created_at_idx" ON "performance_insight_reports"("workspace_id", "channel_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "performance_recommendations_workspace_id_id_key" ON "performance_recommendations"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "performance_recommendations_workspace_id_channel_id_status_rank_idx" ON "performance_recommendations"("workspace_id", "channel_id", "status", "rank");

-- CreateIndex
CREATE INDEX "performance_recommendations_workspace_id_report_id_idx" ON "performance_recommendations"("workspace_id", "report_id");

-- CreateIndex
CREATE UNIQUE INDEX "performance_experiments_workspace_id_id_key" ON "performance_experiments"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "performance_experiments_workspace_id_channel_id_status_created_at_idx" ON "performance_experiments"("workspace_id", "channel_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "performance_strategy_changes_workspace_id_id_key" ON "performance_strategy_changes"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "performance_strategy_changes_workspace_id_recommendation_id_key" ON "performance_strategy_changes"("workspace_id", "recommendation_id");

-- CreateIndex
CREATE UNIQUE INDEX "performance_strategy_changes_workspace_id_channel_id_version_key" ON "performance_strategy_changes"("workspace_id", "channel_id", "version");

-- CreateIndex
CREATE INDEX "performance_strategy_changes_workspace_id_channel_id_created_at_idx" ON "performance_strategy_changes"("workspace_id", "channel_id", "created_at");

-- AddForeignKey
ALTER TABLE "performance_insight_reports" ADD CONSTRAINT "performance_insight_reports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_insight_reports" ADD CONSTRAINT "performance_insight_reports_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_recommendations" ADD CONSTRAINT "performance_recommendations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_recommendations" ADD CONSTRAINT "performance_recommendations_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_recommendations" ADD CONSTRAINT "performance_recommendations_workspace_id_report_id_fkey" FOREIGN KEY ("workspace_id", "report_id") REFERENCES "performance_insight_reports"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_experiments" ADD CONSTRAINT "performance_experiments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_experiments" ADD CONSTRAINT "performance_experiments_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_strategy_changes" ADD CONSTRAINT "performance_strategy_changes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_strategy_changes" ADD CONSTRAINT "performance_strategy_changes_workspace_id_channel_id_fkey" FOREIGN KEY ("workspace_id", "channel_id") REFERENCES "channels"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_strategy_changes" ADD CONSTRAINT "performance_strategy_changes_workspace_id_recommendation_id_fkey" FOREIGN KEY ("workspace_id", "recommendation_id") REFERENCES "performance_recommendations"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
