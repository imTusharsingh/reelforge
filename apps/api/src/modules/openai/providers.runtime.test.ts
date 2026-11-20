import { runsFixture } from "../runs/runs.fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoragePort } from "../asset/storage/storage.port.js";
import type { ProviderKeys } from "./provider-keys.js";
import type { ProviderVideoHealth } from "./provider-video-health.js";
import { ProviderLedger } from "./provider-ledger.js";
import { ProvidersRuntime } from "./providers.runtime.js";
import { shot, artifact } from "./provider.fixture.js";
import {
  GrokVideo,
  OmniVideo,
  ProviderFailure,
  type VideoRoutingState,
} from "@reelforge/ai-providers";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("registered provider runtime", () => {
  it("constructs all configured ports offline and wraps dispatch with ledger and limiter", async () => {
    for (const name of ["VIDEO", "IMAGE", "TEXT", "TTS", "MUSIC"])
      vi.stubEnv(`GEMINI_${name}_MODEL`, name.toLowerCase());
    vi.stubEnv("XAI_VIDEO_MODEL", "fallback");
    const keys = {
      resolve: vi
        .fn()
        .mockImplementation(async (_context, vendor: string) =>
          vendor === "gemini" ? "AIza" + "aB1".repeat(12) : "xai-" + "bC2".repeat(12),
        ),
    };
    const ledger = {
      assertReplaySafe: vi.fn().mockResolvedValue(undefined),
      submit: vi
        .fn<ProviderLedger["submit"]>()
        .mockImplementation(async (_port, _spec, _correlation, _channel, _key, route) => {
          await route?.authorize?.();
          return { providerJobId: "job" };
        }),
      finish: vi.fn().mockResolvedValue(undefined),
    };
    const record = vi.fn().mockResolvedValue(undefined);
    const runtime = new ProvidersRuntime(
      keys as unknown as ProviderKeys,
      ledger as unknown as ProviderLedger,
      { state: vi.fn().mockResolvedValue(new Map()), record } as unknown as ProviderVideoHealth,
      {} as StoragePort,
    );
    const context = { workspaceId: shot.workspaceId, userId: "owner", role: "OWNER" as const };
    const refs = { resolve: vi.fn().mockResolvedValue([]) };
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live forbidden"));
    const ports = await runtime.ports(context, refs);
    expect(Object.keys(ports)).toEqual([
      "assertKey",
      "omni",
      "grok",
      "image",
      "text",
      "tts",
      "music",
    ]);
    expect(fetcher).not.toHaveBeenCalled();
    const allow = vi.fn().mockResolvedValue(undefined);
    const rewrite = vi.fn(async (spec: typeof shot) => spec);
    const router = await runtime.router(context, null, refs, rewrite, allow);
    const job = await router.submit(shot, "run:shot:1", ["gemini", "xai"]);
    expect(job.providerJobId).toBe("job");
    expect(record).toHaveBeenCalledWith(context.workspaceId, "gemini", "ACCEPTED");
    expect(ledger.submit).toHaveBeenCalledWith(
      expect.anything(),
      shot,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      null,
      "run:shot:1:gemini",
      expect.any(Object),
    );
    await expect(
      router.submit({ ...shot, workspaceId: "other" }, "other", ["gemini", "xai"]),
    ).rejects.toThrow("Cross-workspace");
    for (const failure of [
      new ProviderFailure("OUTAGE", true),
      new ProviderFailure("REFUSAL", false, 0, { status: 403, code: "PERMISSION_DENIED" }),
    ]) {
      const key = `run:shot:${failure.kind}`;
      ledger.submit.mockClear().mockRejectedValueOnce(failure);
      await expect(router.submit(shot, key, ["gemini", "xai"])).rejects.toBe(failure);
      expect(ledger.submit).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        shot,
        expect.any(String),
        null,
        `${key}:gemini`,
        expect.any(Object),
      );
      expect(allow).not.toHaveBeenCalled();
      expect(rewrite).not.toHaveBeenCalled();
    }
    ledger.submit.mockClear().mockRejectedValueOnce(new ProviderFailure("OUTAGE", false));
    const fallback = await router.submit(shot, "run:shot:2", ["gemini", "xai"]);
    expect(fallback).toMatchObject({ providerId: "xai", providerJobId: "job" });
    expect(allow).toHaveBeenCalledOnce();
    expect(allow).toHaveBeenCalledWith("xai", ports.grok.estimate(shot));
    expect(ledger.submit).toHaveBeenCalledTimes(2);
    expect(ledger.submit).toHaveBeenLastCalledWith(
      expect.anything(),
      shot,
      expect.any(String),
      null,
      "run:shot:2:xai",
      expect.any(Object),
    );
    vi.spyOn(ports.omni, "fetch").mockResolvedValue(artifact);
    await runtime.reconcile(context.workspaceId, "run:shot:1:gemini", ports.omni, "job");
    expect(ledger.finish).toHaveBeenCalledWith(
      context.workspaceId,
      expect.any(String),
      ports.omni,
      artifact,
    );
    keys.resolve.mockResolvedValue("placeholder");
    ledger.submit.mockClear();
    const invalid = await runtime.router(context, null, refs, async (spec) => spec, allow);
    await expect(invalid.submit(shot, "run:shot:3", ["gemini", "xai"])).rejects.toMatchObject({
      kind: "INVALID_KEY",
      dispatched: false,
    });
    expect(ledger.submit).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("durable video router admission", () => {
  const fixture = runsFixture();
  it("blocks same-key replay before xAI authorization with an open circuit and after restart", async () => {
    const t = await fixture.tenant();
    vi.stubEnv("GEMINI_VIDEO_MODEL", "omni-fixture");
    vi.stubEnv("XAI_VIDEO_MODEL", "xai-fixture");
    const keys = {
      resolve: async (_context: unknown, vendor: string): Promise<string> =>
        vendor === "gemini" ? "AIza" + "aB1".repeat(12) : "xai-" + "bC2".repeat(12),
    };
    const runtime = (state: VideoRoutingState): ProvidersRuntime =>
      new ProvidersRuntime(
        keys as unknown as ProviderKeys,
        new ProviderLedger(t.db, t.usage),
        {
          state: async () => state,
          record: async () => undefined,
        } as unknown as ProviderVideoHealth,
        t.storage,
      );
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}", { status: 503 }));
    const spec = { ...shot, workspaceId: t.context.workspaceId };
    const allow = vi.fn().mockResolvedValue(undefined);
    const build = (state: VideoRoutingState): ReturnType<ProvidersRuntime["router"]> =>
      runtime(state).router(
        t.context,
        t.run.channelId,
        { resolve: async () => [] },
        async (value) => value,
        allow,
      );
    const channelRoute = ["gemini", "xai"];
    const router = await build(new Map());
    for (const key of ["logical", "other-1", "other-2"])
      await expect(router.submit(spec, key, channelRoute)).rejects.toMatchObject({
        kind: "OUTAGE",
        dispatched: true,
      });
    expect(router.matrix().find((item) => item.providerId === "gemini")?.health).toBe(
      "UNAVAILABLE",
    );
    await expect(router.submit(spec, "logical", channelRoute)).rejects.toThrow(
      "reconcile before replay",
    );
    const restarted = await build(new Map());
    await expect(restarted.submit(spec, "logical", channelRoute)).rejects.toThrow(
      "reconcile before replay",
    );
    expect(allow).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      await t.db.providerRequest.count({
        where: {
          workspaceId: t.context.workspaceId,
          errorCode: "UNCERTAIN",
          providerId: "gemini",
          actualCost: null,
        },
      }),
    ).toBe(3);
    expect(
      await t.db.providerRequest.count({
        where: { workspaceId: t.context.workspaceId, providerId: "xai" },
      }),
    ).toBe(0);
    vi.spyOn(OmniVideo.prototype, "submit").mockRejectedValueOnce(
      new ProviderFailure("OUTAGE", false),
    );
    const fallback = vi
      .spyOn(GrokVideo.prototype, "submit")
      .mockResolvedValueOnce({ providerJobId: "xai-fixture-job" });
    await expect(restarted.submit(spec, "safe-fallback", channelRoute)).resolves.toMatchObject({
      providerId: "xai",
      providerJobId: "xai-fixture-job",
    });
    expect(allow).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    expect(
      await t.db.providerRequest.count({
        where: {
          workspaceId: t.context.workspaceId,
          providerId: "gemini",
          errorCode: "NOT_DISPATCHED",
        },
      }),
    ).toBe(1);
    const primary = vi.mocked(OmniVideo.prototype.submit);
    primary
      .mockClear()
      .mockRejectedValueOnce(new ProviderFailure("REFUSAL", true))
      .mockResolvedValueOnce({ providerJobId: "rewritten-job" });
    await expect(
      restarted.submit(spec, "refused-then-rewritten", channelRoute),
    ).resolves.toMatchObject({
      providerId: "gemini",
      providerJobId: "rewritten-job",
      rewrites: 1,
    });
    await expect(restarted.submit(spec, "refused-then-rewritten", channelRoute)).rejects.toThrow(
      "reconcile before replay",
    );
    expect(primary).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledOnce();
  });
});
