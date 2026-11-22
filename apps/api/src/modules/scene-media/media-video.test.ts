import { describe, expect, it, vi } from "vitest";
import {
  ProviderFailure,
  capabilityCatalog,
  secondsCost,
  type VideoGenPort,
} from "@reelforge/ai-providers";
import { planningFixture, shotsFixture } from "../script/planning.fixture.js";
import type { MediaJobs } from "./media-jobs.js";
import type { Run } from "../runs/runs.types.js";
import { RoutedMediaVideo } from "./media-video.js";
const catalog = capabilityCatalog(
  planningFixture().brief.workspaceId,
  {
    video: "configured-video",
    xaiVideo: "configured-fallback",
    image: "configured-image",
    text: "configured-text",
    tts: "configured-voice",
    music: "configured-music",
  },
  { gemini: true, xai: true },
);
function native(providerId = "gemini"): VideoGenPort {
  const cap = catalog.find((row) => row.providerId === providerId && row.kind === "VIDEO")!;
  return {
    capabilities: () => cap,
    estimate: (shot) => secondsCost(shot.durationSeconds, cap.pricePerSecond["720p"]!),
    submit: vi.fn().mockResolvedValue({ providerJobId: "fixture-job" }),
    poll: vi.fn().mockResolvedValue("succeeded"),
    fetch: vi.fn().mockResolvedValue({
      objectKey: "fixture",
      checksumSha256: "a".repeat(64),
      byteSize: 16,
      mimeType: "video/mp4",
      width: 720,
      height: 1280,
      fps: 24,
      durationSeconds: 8,
      billedSeconds: 8,
    }),
  };
}
describe("V5 landed router bridge", () => {
  const shot = { ...shotsFixture(planningFixture())[0]!, durationSeconds: 8 };
  const context = { workspaceId: shot.workspaceId, userId: "user", role: "OWNER" as const };
  it("uses the V2 router, forwards image/extension options and retains real provider metadata", async () => {
    const port = native(),
      bytes = vi.fn().mockResolvedValue(Buffer.from("fixture-video"));
    const options = {
      firstFrame: { type: "image" as const, mime_type: "image/png", data: "fixture" },
    };
    const bridge = new RoutedMediaVideo(
      port,
      { bytes } as unknown as MediaJobs,
      context,
      {} as Run,
      options,
    );
    expect(bridge.providerId).toBe("gemini");
    expect(bridge.estimate(shot)).toBe(56);
    await bridge.submit(shot, "durable-key");
    expect(port.submit).toHaveBeenCalledWith(shot, "durable-key:gemini", options);
    expect(await bridge.poll("fixture-job")).toBe("succeeded");
    const receipt = await bridge.collectReceipt("fixture-job", shot);
    expect(await bridge.fetch("fixture-job", receipt.media!)).toEqual(Buffer.from("fixture-video"));
    expect(port.fetch).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      seconds: 8,
      costMinor: 56,
      modelId: "configured-video",
    });
    expect(await bridge.reconcile()).toBeNull();
  });
  it("refetches a previously saved invalid descriptor and records the verified replacement", async () => {
    const port = native();
    const valid = await port.fetch("fixture-job");
    vi.mocked(port.fetch).mockClear();
    const bytes = vi.fn().mockResolvedValue(Buffer.from("valid"));
    const bridge = new RoutedMediaVideo(
      port,
      { bytes } as unknown as MediaJobs,
      context,
      {} as Run,
    );
    const record = vi.fn();
    await expect(
      bridge.fetch("fixture-job", { ...valid, fps: 30 }, { shot, record }),
    ).resolves.toEqual(Buffer.from("valid"));
    expect(port.fetch).toHaveBeenCalledExactlyOnceWith("fixture-job", expect.any(Function));
    expect(bytes).toHaveBeenCalledExactlyOnceWith(context, valid);
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ media: valid, costBasis: "BILLED" }),
    );
  });
  it("does not resubmit uncertain calls, rewrite without a reservation, or switch vendors on refusal/429", async () => {
    for (const kind of ["OUTAGE", "RATE_LIMIT", "REFUSAL"] as const) {
      const port = native();
      vi.mocked(port.submit).mockRejectedValue(new ProviderFailure(kind, false));
      const bridge = new RoutedMediaVideo(port, {} as MediaJobs, context, {} as Run);
      await expect(bridge.submit(shot, "key")).rejects.toBeInstanceOf(ProviderFailure);
      expect(port.submit).toHaveBeenCalledOnce();
    }
  });
  it("rejects invalid video metadata and counts additional Grok input frames", async () => {
    const port = native("xai");
    const jobs = {
      bytes: vi.fn().mockResolvedValue(Buffer.from("fixture")),
    } as unknown as MediaJobs;
    const bridge = new RoutedMediaVideo(port, jobs, context, {} as Run, {
      firstFrame: { type: "image", mime_type: "image/png", data: "fixture" },
    });
    expect(bridge.estimate(shot)).toBe(113);
    vi.mocked(port.fetch).mockResolvedValue({
      objectKey: "fixture",
      checksumSha256: "a".repeat(64),
      byteSize: 1,
      mimeType: "application/json",
      durationSeconds: 8,
      width: 720,
      height: 1280,
      fps: 24,
      billedSeconds: 8,
    });
    const record = vi.fn();
    await expect(bridge.collectReceipt("fixture-job", shot, { shot, record })).rejects.toThrow(
      "invalid 720p video",
    );
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        seconds: 8,
        costBasis: "BILLED",
        media: null,
      }),
    );
  });
});

it("extracts only the newly generated extension tail before assembly", async () => {
  const shot = { ...shotsFixture(planningFixture())[0]!, durationSeconds: 8 };
  const port = native(),
    trim = vi.fn().mockResolvedValue(Buffer.from("new-extension-tail"));
  const bridge = new RoutedMediaVideo(
    port,
    {
      bytes: async (): Promise<Buffer> => Buffer.from("complete-extended-clip"),
    } as unknown as MediaJobs,
    { workspaceId: shot.workspaceId, userId: "user", role: "OWNER" },
    {} as Run,
    { extension: { providerJobId: "previous-own-job", previousSeconds: 8 } },
    undefined,
    trim,
  );
  expect(await bridge.fetch("extended-job")).toEqual(Buffer.from("new-extension-tail"));
  expect(trim).toHaveBeenCalledWith(Buffer.from("complete-extended-clip"), 8);
});
