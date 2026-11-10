import { currentContext } from "./context.js";
import { redact, redactString } from "./redaction.js";

/**
 * Structured JSON logger (M19-T03). One JSON object per line with `ts`, `level`, `service`,
 * `msg`, the active `correlationId` / `traceId` / `spanId`, and redacted fields. No dependency:
 * an OpenTelemetry log exporter can tail stdout/stderr. Every message and field is redacted.
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export type LogSink = (line: string, level: LogLevel) => void;

export type StructuredLoggerOptions = Readonly<{
  service: string;
  level?: LogLevel;
  sink?: LogSink;
  clock?: () => Date;
}>;

function defaultSink(line: string, level: LogLevel): void {
  if (LEVEL_ORDER[level] >= LEVEL_ORDER.warn) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && normalized in LEVEL_ORDER
    ? (normalized as LogLevel)
    : fallback;
}

export class StructuredLogger {
  private readonly service: string;
  private readonly minimum: number;
  private readonly sink: LogSink;
  private readonly clock: () => Date;

  public constructor(options: StructuredLoggerOptions) {
    this.service = options.service;
    this.minimum = LEVEL_ORDER[options.level ?? "info"];
    this.sink = options.sink ?? defaultSink;
    this.clock = options.clock ?? ((): Date => new Date());
  }

  public isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= this.minimum;
  }

  public write(
    level: LogLevel,
    message: unknown,
    fields: Readonly<Record<string, unknown>> = {},
  ): void {
    if (!this.isEnabled(level)) return;
    const context = currentContext();
    const entry: Record<string, unknown> = {
      ts: this.clock().toISOString(),
      level,
      service: this.service,
      msg: typeof message === "string" ? redactString(message) : redact(message),
      ...(context
        ? {
            correlationId: context.correlationId,
            traceId: context.traceId,
            spanId: context.spanId,
          }
        : {}),
    };
    const safe = redact(fields);
    if (safe !== null && typeof safe === "object" && !Array.isArray(safe)) {
      for (const [key, value] of Object.entries(safe)) {
        if (!(key in entry)) entry[key] = value;
        else entry[`field_${key}`] = value;
      }
    }
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({
        ts: entry["ts"],
        level,
        service: this.service,
        msg: "[Unserializable log entry]",
      });
    }
    this.sink(line, level);
  }

  public debug(message: unknown, fields?: Readonly<Record<string, unknown>>): void {
    this.write("debug", message, fields);
  }

  public info(message: unknown, fields?: Readonly<Record<string, unknown>>): void {
    this.write("info", message, fields);
  }

  public warn(message: unknown, fields?: Readonly<Record<string, unknown>>): void {
    this.write("warn", message, fields);
  }

  public error(message: unknown, fields?: Readonly<Record<string, unknown>>): void {
    this.write("error", message, fields);
  }

  /** Same shape as `console.*` arguments: first string is the message, the rest are `args`. */
  public writeArgs(level: LogLevel, args: readonly unknown[]): void {
    const [first, ...rest] = args;
    const message = typeof first === "string" ? first : "";
    const extra = typeof first === "string" ? rest : args;
    this.write(level, message, extra.length === 0 ? {} : { args: extra });
  }
}

/**
 * Adapter with the Nest `LoggerService` method shape (`log`, `error`, `warn`, `debug`, `verbose`,
 * `fatal`), so `app.useLogger(...)` routes framework and module `Logger` output through redaction.
 * Structural typing only: this package does not depend on Nest.
 */
export class FrameworkLoggerAdapter {
  public constructor(private readonly logger: StructuredLogger) {}

  public log(message: unknown, ...optional: unknown[]): void {
    this.forward("info", message, optional);
  }

  public error(message: unknown, ...optional: unknown[]): void {
    this.forward("error", message, optional);
  }

  public warn(message: unknown, ...optional: unknown[]): void {
    this.forward("warn", message, optional);
  }

  public debug(message: unknown, ...optional: unknown[]): void {
    this.forward("debug", message, optional);
  }

  public verbose(message: unknown, ...optional: unknown[]): void {
    this.forward("debug", message, optional);
  }

  public fatal(message: unknown, ...optional: unknown[]): void {
    this.forward("fatal", message, optional);
  }

  private forward(level: LogLevel, message: unknown, optional: readonly unknown[]): void {
    // Nest passes the context (logger name) as the last string argument.
    const last = optional.at(-1);
    const component = typeof last === "string" ? last : undefined;
    const rest = component === undefined ? optional : optional.slice(0, -1);
    this.logger.write(level, message, {
      ...(component === undefined ? {} : { component }),
      ...(rest.length === 0 ? {} : { args: rest }),
    });
  }
}

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const CONSOLE_LEVELS: Readonly<Record<ConsoleMethod, LogLevel>> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

/**
 * Routes `console.*` through the structured logger, so existing module `console.error(...)` calls
 * (composition, orchestration, workers) are redacted without editing those modules. Returns a
 * function that restores the original console methods.
 */
export function installConsoleRedaction(
  logger: StructuredLogger,
  target: Console = console,
): () => void {
  const originals = new Map<ConsoleMethod, Console[ConsoleMethod]>();
  for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    originals.set(method, target[method]);
    target[method] = (...args: unknown[]): void => logger.writeArgs(CONSOLE_LEVELS[method], args);
  }
  return (): void => {
    for (const [method, original] of originals) target[method] = original;
  };
}
