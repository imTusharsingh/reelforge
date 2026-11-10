import { redactString } from "./redaction.js";

/**
 * In-process metrics registry (M19-T03): counters, gauges, and histograms rendered in the
 * Prometheus/OpenMetrics text format, which OpenTelemetry collectors scrape. No dependency.
 * Label values are redacted and bounded so ids, URLs, and secrets cannot become label values.
 */
export type Labels = Readonly<Record<string, string | number | boolean>>;

const MAX_LABEL_LENGTH = 120;
const MAX_SERIES_PER_METRIC = 500;
const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${String(labels[key])}`)
    .join(",");
}

function sanitizeLabels(labels: Labels): Labels {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (!NAME_PATTERN.test(key)) continue;
    out[key] = redactString(String(value)).slice(0, MAX_LABEL_LENGTH);
  }
  return out;
}

function renderLabels(labels: Labels, extra: Labels = {}): string {
  const merged = { ...labels, ...extra };
  const keys = Object.keys(merged).sort();
  if (keys.length === 0) return "";
  const parts = keys.map((key) => {
    const value = String(merged[key])
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/"/g, '\\"');
    return `${key}="${value}"`;
  });
  return `{${parts.join(",")}}`;
}

type Series<T> = { labels: Labels; value: T };

abstract class Metric<T> {
  protected readonly series = new Map<string, Series<T>>();
  public dropped = 0;

  public constructor(
    public readonly name: string,
    public readonly help: string,
  ) {
    if (!NAME_PATTERN.test(name)) throw new Error(`Invalid metric name: ${name}`);
  }

  protected entry(labels: Labels, initial: () => T): Series<T> | undefined {
    const safe = sanitizeLabels(labels);
    const key = labelKey(safe);
    const existing = this.series.get(key);
    if (existing) return existing;
    if (this.series.size >= MAX_SERIES_PER_METRIC) {
      this.dropped += 1;
      return undefined;
    }
    const created = { labels: safe, value: initial() };
    this.series.set(key, created);
    return created;
  }

  public abstract render(): string[];

  public reset(): void {
    this.series.clear();
    this.dropped = 0;
  }
}

export class Counter extends Metric<number> {
  public inc(labels: Labels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) return;
    const series = this.entry(labels, () => 0);
    if (series) series.value += amount;
  }

  public get(labels: Labels = {}): number {
    return this.series.get(labelKey(sanitizeLabels(labels)))?.value ?? 0;
  }

  public render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const series of this.series.values())
      lines.push(`${this.name}${renderLabels(series.labels)} ${series.value}`);
    return lines;
  }
}

export class Gauge extends Metric<number> {
  public set(labels: Labels, value: number): void {
    if (!Number.isFinite(value)) return;
    const series = this.entry(labels, () => 0);
    if (series) series.value = value;
  }

  public get(labels: Labels = {}): number | undefined {
    return this.series.get(labelKey(sanitizeLabels(labels)))?.value;
  }

  public render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const series of this.series.values())
      lines.push(`${this.name}${renderLabels(series.labels)} ${series.value}`);
    return lines;
  }
}

type HistogramValue = { buckets: number[]; sum: number; count: number };

export class Histogram extends Metric<HistogramValue> {
  public constructor(
    name: string,
    help: string,
    public readonly bounds: readonly number[] = [
      5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
    ],
  ) {
    super(name, help);
  }

  public observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const series = this.entry(labels, () => ({
      buckets: this.bounds.map(() => 0),
      sum: 0,
      count: 0,
    }));
    if (!series) return;
    this.bounds.forEach((bound, index) => {
      if (value <= bound) series.value.buckets[index] = (series.value.buckets[index] ?? 0) + 1;
    });
    series.value.sum += value;
    series.value.count += 1;
  }

  public count(labels: Labels = {}): number {
    return this.series.get(labelKey(sanitizeLabels(labels)))?.value.count ?? 0;
  }

  public render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const series of this.series.values()) {
      this.bounds.forEach((bound, index) => {
        lines.push(
          `${this.name}_bucket${renderLabels(series.labels, { le: String(bound) })} ${series.value.buckets[index] ?? 0}`,
        );
      });
      lines.push(
        `${this.name}_bucket${renderLabels(series.labels, { le: "+Inf" })} ${series.value.count}`,
      );
      lines.push(`${this.name}_sum${renderLabels(series.labels)} ${series.value.sum}`);
      lines.push(`${this.name}_count${renderLabels(series.labels)} ${series.value.count}`);
    }
    return lines;
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric<unknown>>();

  public counter(name: string, help: string): Counter {
    return this.register(name, () => new Counter(name, help), Counter);
  }

  public gauge(name: string, help: string): Gauge {
    return this.register(name, () => new Gauge(name, help), Gauge);
  }

  public histogram(name: string, help: string, bounds?: readonly number[]): Histogram {
    return this.register(name, () => new Histogram(name, help, bounds), Histogram);
  }

  /** Prometheus text exposition format (version 0.0.4). */
  public render(): string {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) lines.push(...metric.render());
    return `${lines.join("\n")}\n`;
  }

  public reset(): void {
    for (const metric of this.metrics.values()) metric.reset();
  }

  private register<M extends Metric<unknown>>(
    name: string,
    create: () => M,
    type: abstract new (...args: never[]) => M,
  ): M {
    const existing = this.metrics.get(name);
    if (existing) {
      if (!(existing instanceof type))
        throw new Error(`Metric ${name} already registered with another type`);
      return existing as M;
    }
    const created = create();
    this.metrics.set(name, created as Metric<unknown>);
    return created;
  }
}

/** Process-wide default registry. */
export const metrics = new MetricsRegistry();
