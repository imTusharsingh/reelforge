import "reflect-metadata";
import { createCompositionPoller } from "./handlers/composition/factory.js";
import { CompositionWorkerHandler } from "./handlers/composition/handler.js";
import { createOrchestrationRuntime } from "./handlers/orchestration/factory.js";
import { OrchestrationWorkerHandler } from "./handlers/orchestration/handler.js";

const composition = createCompositionPoller(process.env);
const compositionHandler = new CompositionWorkerHandler((batch) =>
  composition.service.runScheduled(batch),
);
compositionHandler.closeResources = composition.close;

const orchestrationRuntime = await createOrchestrationRuntime(process.env);
const orchestrationHandler = new OrchestrationWorkerHandler(orchestrationRuntime);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([compositionHandler.stop(), orchestrationHandler.stop()]);
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void shutdown());

await Promise.all([compositionHandler.start(), orchestrationHandler.start()]);
