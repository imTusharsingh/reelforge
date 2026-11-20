import { createVideoRunsConsumer, type VideoRunsConsumer } from "./video-runs.js";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "@reelforge/api/app-module";

export type OrchestrationRuntime = Readonly<{
  app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;
  videoRuns?: VideoRunsConsumer;
  close: () => Promise<void>;
}>;

export async function createOrchestrationRuntime(
  env: NodeJS.ProcessEnv,
): Promise<OrchestrationRuntime> {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required by the orchestration worker");
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  try {
    const redisUrl = env.REDIS_URL?.trim();
    const videoRuns = redisUrl ? await createVideoRunsConsumer(app, redisUrl) : undefined;
    return {
      app,
      ...(videoRuns ? { videoRuns } : {}),
      close: async (): Promise<void> => {
        try {
          await videoRuns?.close();
        } finally {
          await app.close();
        }
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}
