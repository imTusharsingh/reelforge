import type { StructuredLogger } from "./logger.js";

type ProcessErrorTarget = Readonly<{
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  off(event: "uncaughtException", listener: (error: Error) => void): unknown;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}>;

export type ProcessErrorHandlerOptions = Readonly<{
  /** Defaults to `process`. */
  target?: ProcessErrorTarget;
  /** Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Exit code after a fatal error; defaults to 1. */
  exitCode?: number;
}>;

/**
 * M19 residual R2: routes `uncaughtException` and `unhandledRejection` through the redacting
 * structured logger (instead of Node's default stderr dump, which prints raw messages and stacks),
 * then exits non-zero. Returns a function that removes the handlers.
 */
export function installProcessErrorHandlers(
  logger: StructuredLogger,
  options: ProcessErrorHandlerOptions = {},
): () => void {
  const target: ProcessErrorTarget = options.target ?? process;
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const exitCode = options.exitCode ?? 1;
  let exiting = false;
  const fail = (kind: string, error: unknown): void => {
    try {
      logger.write("fatal", kind, { error });
    } catch {
      // Logging must never stop the process from exiting.
    }
    if (exiting) return;
    exiting = true;
    exit(exitCode);
  };
  const onException = (error: Error): void => fail("uncaught exception", error);
  const onRejection = (reason: unknown): void => fail("unhandled rejection", reason);
  target.on("uncaughtException", onException);
  target.on("unhandledRejection", onRejection);
  return (): void => {
    target.off("uncaughtException", onException);
    target.off("unhandledRejection", onRejection);
  };
}
