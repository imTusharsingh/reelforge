import "reflect-metadata";
import { createCompositionPoller } from "./handlers/composition/factory.js";
import { CompositionWorkerHandler } from "./handlers/composition/handler.js";

const { service, close } = createCompositionPoller(process.env);
const handler = new CompositionWorkerHandler((batch) => service.runScheduled(batch));
handler.closeResources = close;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void handler.stop().finally(() => process.exit(0)));
await handler.start();
