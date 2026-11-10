import "reflect-metadata";
import { Logger } from "@nestjs/common";
import {
  bootstrapProcessObservability,
  installProcessErrorHandlers,
} from "@reelforge/observability";
import { createCompositionPoller } from "./handlers/composition/factory.js";
import { CompositionWorkerHandler } from "./handlers/composition/handler.js";
import { createOrchestrationRuntime } from "./handlers/orchestration/factory.js";
import { OrchestrationWorkerHandler } from "./handlers/orchestration/handler.js";
import { createNotificationsRuntime } from "./handlers/notifications/factory.js";
import { NotificationsWorkerHandler } from "./handlers/notifications/handler.js";

// M19-T03: redacting JSON logs for console.* and every Nest context the worker boots.
const observability = bootstrapProcessObservability("worker");
Logger.overrideLogger(observability.frameworkLogger);
// M19 R2: uncaught exceptions and unhandled rejections are logged through redaction and exit 1.
installProcessErrorHandlers(observability.logger);

const composition = createCompositionPoller(process.env);
const compositionHandler = new CompositionWorkerHandler((batch) =>
  composition.service.runScheduled(batch),
);
compositionHandler.closeResources = composition.close;

const orchestrationRuntime = await createOrchestrationRuntime(process.env);
const orchestrationHandler = new OrchestrationWorkerHandler(orchestrationRuntime);

const notificationsRuntime = await createNotificationsRuntime(process.env);
const notificationsHandler = new NotificationsWorkerHandler(notificationsRuntime);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([
    compositionHandler.stop(),
    orchestrationHandler.stop(),
    notificationsHandler.stop(),
  ]);
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown());

await Promise.all([
  compositionHandler.start(),
  orchestrationHandler.start(),
  notificationsHandler.start(),
]);
