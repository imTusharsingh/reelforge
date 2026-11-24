import type { VideoGenPort as NativeVideoGenPort } from "@reelforge/ai-providers";
import type { ShotSpec } from "@reelforge/contracts";
import type { VideoGenPort as RunVideoGenPort } from "../orchestration/video-run.handlers.js";
import type { RoutedMediaVideo } from "../scene-media/media-video.js";

/** Test-only adapter for exercising receipt handling without a live provider. */
export class CappedTestVideoPort implements RunVideoGenPort {
  public readonly enforcesPerCallChargeCeiling = true;
  public constructor(
    private readonly bridge: RoutedMediaVideo,
    private readonly native: NativeVideoGenPort,
  ) {}
  public get providerId(): string {
    return this.bridge.providerId;
  }
  public get modelId(): string {
    return this.bridge.modelId;
  }
  public assertKey(): void {
    this.bridge.assertKey();
  }
  public estimate(shot: ShotSpec, fallback: boolean): number {
    if (fallback && this.providerId !== "xai") throw new Error("Fallback test port mismatch");
    return this.bridge.estimate(shot);
  }
  public async submit(
    shot: ShotSpec,
    key: string,
    maximumCostMinor: number,
  ): Promise<{ providerJobId: string }> {
    if (!Number.isSafeInteger(maximumCostMinor) || maximumCostMinor < 0)
      throw new Error("Test provider requires a valid maximum charge");
    return this.native.submit(shot, `${key}:${this.providerId}`);
  }
  public reconcile(): ReturnType<RoutedMediaVideo["reconcile"]> {
    return this.bridge.reconcile();
  }
  public poll(
    id: string,
    billing?: Parameters<RoutedMediaVideo["poll"]>[1],
  ): ReturnType<RoutedMediaVideo["poll"]> {
    return this.bridge.poll(id, billing);
  }
  public fetch(
    id: string,
    media?: Parameters<RoutedMediaVideo["fetch"]>[1],
    billing?: Parameters<RoutedMediaVideo["fetch"]>[2],
  ): ReturnType<RoutedMediaVideo["fetch"]> {
    return this.bridge.fetch(id, media, billing);
  }
  public collectReceipt(
    id: string,
    shot: Parameters<RoutedMediaVideo["collectReceipt"]>[1],
    billing?: Parameters<RoutedMediaVideo["collectReceipt"]>[2],
  ): ReturnType<RoutedMediaVideo["collectReceipt"]> {
    return this.bridge.collectReceipt(id, shot, billing);
  }
}
