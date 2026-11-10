import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  bootstrapProcessObservability,
  installProcessErrorHandlers,
} from "@reelforge/observability";
import { AppModule } from "./app.module.js";

// M19-T03: redacting JSON logs for console.* and the Nest logger.
const { logger, frameworkLogger } = bootstrapProcessObservability("api");
// M19 R2: uncaught exceptions and unhandled rejections (including a failed bootstrap) are logged
// through redaction and exit non-zero.
installProcessErrorHandlers(logger);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: frameworkLogger,
  });
  // Asset uploads use base64 JSON so no multipart dependency is required. Allow
  // the largest supported asset (25 MB default) plus JSON/base64 overhead.
  app.useBodyParser("json", { limit: "40mb" });
  app.setGlobalPrefix("api/v1");
  await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
