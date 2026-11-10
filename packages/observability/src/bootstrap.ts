import {
  FrameworkLoggerAdapter,
  StructuredLogger,
  installConsoleRedaction,
  parseLogLevel,
} from "./logger.js";
import { registerSecretEnv } from "./redaction.js";
import { setSpanExporter } from "./tracing.js";

export type ProcessObservability = Readonly<{
  logger: StructuredLogger;
  frameworkLogger: FrameworkLoggerAdapter;
  restoreConsole: () => void;
}>;

/**
 * Process start-up (API and worker): registers secret env values for masking, routes `console.*`
 * and the framework logger through the redacting JSON logger, and logs finished spans at debug.
 */
export function bootstrapProcessObservability(
  service: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProcessObservability {
  registerSecretEnv(env);
  const logger = new StructuredLogger({ service, level: parseLogLevel(env["LOG_LEVEL"]) });
  const restoreConsole = installConsoleRedaction(logger);
  setSpanExporter((span) => logger.debug("span", { span }));
  return { logger, frameworkLogger: new FrameworkLoggerAdapter(logger), restoreConsole };
}
