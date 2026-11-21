import type { ShotSpec } from "@reelforge/contracts";
import { ProviderFailure } from "./http.js";
import type { JobStatus, Money, VideoGenPort } from "./ports.js";

export type Route = Readonly<{ port: VideoGenPort; tier: number }>;
export type RoutedJob = Readonly<{
  providerId: string;
  providerJobId: string;
  spec: ShotSpec;
  idemKey: string;
  rewrites: number;
}>;
export interface RouterDispatch {
  submit?(port: VideoGenPort, spec: ShotSpec, idemKey: string): Promise<{ providerJobId: string }>;
  submitRouted?(
    port: VideoGenPort,
    spec: ShotSpec,
    providerKey: string,
    logicalKey: string,
    fallback: boolean,
    replaces?: string,
  ): Promise<{ providerJobId: string }>;
  confirmRefusal?(job: RoutedJob): Promise<void>;
  assertReplaySafe?(spec: ShotSpec, logicalKey: string): Promise<void>;
  /** V3 re-estimates its envelope before a fallback is allowed to spend. */
  allowFallback(providerId: string, estimate: Money): Promise<void>;
}
type VideoRouteStats = { failures: number; openUntil: number; accepted: number; calls: number };
export type VideoOutcome = "ACCEPTED" | "OUTAGE" | "REJECTED";
export type RecordVideoOutcome = (providerId: string, outcome: VideoOutcome) => Promise<void>;
export type VideoRoutingState = Map<string, VideoRouteStats>;
export function videoHealth(
  configured: ReturnType<VideoGenPort["capabilities"]>["health"],
  state: VideoRouteStats | undefined,
  now: number,
): ReturnType<VideoGenPort["capabilities"]>["health"] {
  if (configured !== "HEALTHY" || !state) return configured;
  if (state.openUntil > now) return "UNAVAILABLE";
  const lowAcceptance = state.calls > 0 && state.accepted / state.calls < 0.9;
  return state.failures > 0 || lowAcceptance ? "DEGRADED" : "HEALTHY";
}

export class VideoRouter {
  public constructor(
    private readonly routes: readonly Route[],
    private readonly dispatch: RouterDispatch,
    private readonly rewrite: ((spec: ShotSpec) => Promise<ShotSpec>) | undefined,
    private readonly now: () => number = Date.now,
    private readonly health: VideoRoutingState = new Map(),
    private readonly recordOutcome?: RecordVideoOutcome,
  ) {}
  public matrix(): ReadonlyArray<ReturnType<VideoGenPort["capabilities"]>> {
    return this.routes.map(({ port }) => {
      const cap = port.capabilities();
      return {
        ...cap,
        health: videoHealth(cap.health, this.health.get(cap.providerId), this.now()),
      };
    });
  }
  public async submit(
    spec: ShotSpec,
    key: string,
    channelRoute: readonly string[],
  ): Promise<RoutedJob> {
    await this.dispatch.assertReplaySafe?.(spec, key);
    const routes = this.select(spec, channelRoute);
    const circuitOpen = channelRoute.some(
      (id) => (this.health.get(id)?.openUntil ?? 0) > this.now(),
    );
    let outage: unknown = new ProviderFailure(circuitOpen ? "OUTAGE" : "NOT_CONFIGURED", false);
    for (const route of routes) {
      const providerId = route.port.capabilities().providerId;
      const fallback = providerId !== channelRoute[0];
      if (fallback && !this.dispatch.submitRouted)
        await this.dispatch.allowFallback(providerId, route.port.estimate(spec));
      try {
        return await this.attempt(route.port, spec, `${key}:${providerId}`, 0, key, fallback);
      } catch (error) {
        if (!(error instanceof ProviderFailure) || error.kind !== "OUTAGE" || error.dispatched)
          throw error;
        outage = error;
      }
    }
    throw outage;
  }
  public async poll(
    job: RoutedJob,
  ): Promise<{ status: JobStatus | "NEEDS_HUMAN"; job: RoutedJob }> {
    const port = this.port(job.providerId);
    const status = await port.poll(job.providerJobId);
    if (status !== "refused") return { status, job };
    if (!this.rewrite || job.rewrites >= 1) return { status: "NEEDS_HUMAN", job };
    await this.dispatch.confirmRefusal?.(job);
    const revised = await this.rewrite(job.spec);
    const logicalKey = job.idemKey.slice(0, -`:${job.providerId}`.length);
    const next = await this.attempt(port, revised, `${job.idemKey}:rewrite`, 1, logicalKey);
    return { status: "queued", job: next };
  }
  private async attempt(
    port: VideoGenPort,
    spec: ShotSpec,
    key: string,
    rewrites: number,
    logicalKey = key,
    fallback = false,
  ): Promise<RoutedJob> {
    const providerId = port.capabilities().providerId;
    const state = this.state(providerId);
    state.calls++;
    try {
      const result = await (this.dispatch.submitRouted
        ? this.dispatch.submitRouted(
            port,
            spec,
            key,
            logicalKey,
            fallback,
            rewrites ? key.slice(0, -":rewrite".length) : undefined,
          )
        : this.dispatch.submit?.(port, spec, key));
      if (!result) throw new Error("Video dispatch is not configured");
      state.accepted++;
      state.failures = 0;
      await this.recordOutcome?.(providerId, "ACCEPTED").catch(() => undefined);
      return { ...result, providerId, spec, idemKey: key, rewrites };
    } catch (error) {
      if (error instanceof ProviderFailure && error.kind === "OUTAGE") {
        state.failures++;
        if (state.failures >= 3) state.openUntil = this.now() + 60000;
      }
      await this.recordOutcome?.(
        providerId,
        error instanceof ProviderFailure && error.kind === "OUTAGE" ? "OUTAGE" : "REJECTED",
      ).catch(() => undefined);
      if (
        error instanceof ProviderFailure &&
        this.rewrite &&
        error.kind === "REFUSAL" &&
        error.dispatched &&
        !error.http
      ) {
        if (rewrites >= 1) throw new ProviderFailure("NEEDS_HUMAN", true);
        return this.attempt(port, await this.rewrite(spec), `${key}:rewrite`, 1, logicalKey);
      }
      throw error;
    }
  }
  private select(spec: ShotSpec, channel: readonly string[]): Route[] {
    return this.routes
      .filter(({ port }) => {
        const cap = port.capabilities();
        return (
          channel.includes(cap.providerId) &&
          cap.enabled &&
          this.state(cap.providerId).openUntil <= this.now() &&
          cap.health !== "NOT_CONFIGURED" &&
          cap.health !== "UNAVAILABLE" &&
          cap.aspects.includes("9:16") &&
          cap.frameRates.includes(spec.fps) &&
          spec.references.length <= cap.maxReferenceImages &&
          spec.durationSeconds >= cap.minDurationSeconds &&
          spec.durationSeconds <= cap.maxDurationSeconds
        );
      })
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          a.port.estimate(spec).microUsd - b.port.estimate(spec).microUsd ||
          this.rank(b) - this.rank(a),
      );
  }
  private rank(route: Route): number {
    const state = this.state(route.port.capabilities().providerId);
    return (
      (state.openUntil > this.now() ? -1 : 0) + (state.calls ? state.accepted / state.calls : 1)
    );
  }
  private port(id: string): VideoGenPort {
    const port = this.routes.find((route) => route.port.capabilities().providerId === id)?.port;
    if (!port) throw new ProviderFailure("NOT_CONFIGURED", false);
    return port;
  }
  private state(id: string): {
    failures: number;
    openUntil: number;
    accepted: number;
    calls: number;
  } {
    let state = this.health.get(id);
    if (!state) {
      state = { failures: 0, openUntil: 0, accepted: 0, calls: 0 };
      this.health.set(id, state);
    }
    return state;
  }
}
