import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import { AppModule } from "@reelforge/api/app-module";
import { OrchestrationService } from "@reelforge/api/orchestration-service";
import { createOrchestrationConsumer, type OrchestrationConsumer } from "./consumer.js";

export type OrchestrationRuntime = Readonly<{
  service: OrchestrationService;
  consumer: OrchestrationConsumer | null;
  close: () => Promise<void>;
}>;

export async function createOrchestrationRuntime(
  env: NodeJS.ProcessEnv,
  options: {
    readonly onError?: (error: unknown) => void;
  } = {},
): Promise<OrchestrationRuntime> {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required by the orchestration worker");
  const app: INestApplicationContext = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn"],
  });
  const service = app.get(OrchestrationService);
  const redisUrl = env.REDIS_URL?.trim();
  let consumer: OrchestrationConsumer | null = null;
  if (redisUrl !== undefined && redisUrl.length > 0) {
    // A set REDIS_URL must work: refuse to start rather than silently never dispatching.
    const queueHealth = await service.queueHealth();
    if (queueHealth !== "CONFIGURED") {
      await service.close();
      await app.close();
      throw new Error(
        `REDIS_URL is set but the workflow queue is ${queueHealth}; refusing to start the orchestration worker`,
      );
    }
    consumer = createOrchestrationConsumer(
      service,
      redisUrl,
      options.onError ? { onError: options.onError } : {},
    );
  }
  return {
    service,
    consumer,
    close: async (): Promise<void> => {
      await consumer?.close();
      await service.close();
      await app.close();
    },
  };
}
