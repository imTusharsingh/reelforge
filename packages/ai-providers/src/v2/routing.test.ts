import { describe, expect, it, vi } from "vitest";
import { ProviderCapabilitySchema } from "@reelforge/contracts";
import { VideoRouter } from "./router.js";
import { ProviderLimiter } from "./limiter.js";
import { ProviderFailure, ProviderHttp, record, requiredString } from "./http.js";
import { providerModels, providerKey } from "./config.js";
import { secondsCost, reservationCents, ledgerUsd } from "./money.js";
import { artifact, catalog, models, shot, json } from "./provider.fixture.js";
import type { VideoGenPort } from "./ports.js";

const omniRate = catalog[0]!.pricePerSecond["720p"]!;

function setup(): {
  router: VideoRouter;
  primary: VideoGenPort;
  fallback: VideoGenPort;
  submit: ReturnType<typeof vi.fn>;
  rewrite: ReturnType<typeof vi.fn>;
  allow: ReturnType<typeof vi.fn>;
} {
  const primary: VideoGenPort = {
    capabilities: () => catalog[0]!,
    estimate: () => secondsCost(8, omniRate),
    submit: vi.fn().mockResolvedValue({ providerJobId: "omni" }),
    poll: vi.fn().mockResolvedValue("refused"),
    fetch: vi.fn().mockResolvedValue(artifact),
  };
  const fallback: VideoGenPort = {
    ...primary,
    capabilities: () => catalog[5]!,
    estimate: () => secondsCost(shot.durationSeconds, catalog[5]!.pricePerSecond["720p"]!),
    submit: vi.fn().mockResolvedValue({ providerJobId: "xai" }),
  };
  const submit = vi.fn(async (port: VideoGenPort, spec: typeof shot, key: string) =>
    port.submit(spec, key),
  );
  const rewrite = vi.fn().mockResolvedValue({ ...shot, motionPrompt: "revised" });
  const allow = vi.fn().mockResolvedValue(undefined);
  return {
    router: new VideoRouter(
      [
        { port: primary, tier: 0 },
        { port: fallback, tier: 1 },
      ],
      { submit, allowFallback: allow },
      rewrite,
      () => 0,
    ),
    primary,
    fallback,
    submit,
    rewrite,
    allow,
  };
}
describe("routing policy", () => {
  it("falls back only on outage, authorizing fallback estimate before submit", async () => {
    const { router, primary, fallback, allow } = setup();
    vi.mocked(primary.submit).mockRejectedValue(new ProviderFailure("OUTAGE", false));
    const job = await router.submit(shot, "run:shot:1", ["gemini", "xai"]);
    expect(job.providerId).toBe("xai");
    expect(allow).toHaveBeenCalledWith("xai", fallback.estimate(shot));
    expect(allow.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fallback.submit).mock.invocationCallOrder[0]!,
    );
  });
  it("rewrites one refusal then signals NEEDS_HUMAN without switching vendor", async () => {
    const { router, primary, fallback, rewrite } = setup();
    vi.mocked(primary.submit).mockRejectedValue(new ProviderFailure("REFUSAL", true));
    await expect(router.submit(shot, "key", ["gemini", "xai"])).rejects.toMatchObject({
      kind: "NEEDS_HUMAN",
    });
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(primary.submit).toHaveBeenCalledTimes(2);
    expect(fallback.submit).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "preserves HTTP refusals unchanged when dispatched is %s",
    async (dispatched) => {
      const { router, primary, fallback, rewrite } = setup();
      const failure = new ProviderFailure("REFUSAL", dispatched, 0, {
        status: 403,
        code: "PERMISSION_DENIED",
      });
      vi.mocked(primary.submit).mockRejectedValue(failure);
      await expect(router.submit(shot, "key", ["gemini", "xai"])).rejects.toBe(failure);
      expect(rewrite).not.toHaveBeenCalled();
      expect(primary.submit).toHaveBeenCalledOnce();
      expect(fallback.submit).not.toHaveBeenCalled();
    },
  );
  it("handles asynchronous refusal with a single same-vendor rewrite", async () => {
    const { router, fallback } = setup();
    const first = await router.submit(shot, "key", ["gemini", "xai"]);
    const next = await router.poll(first);
    expect(next.status).toBe("queued");
    expect((await router.poll(next.job)).status).toBe("NEEDS_HUMAN");
    expect(fallback.submit).not.toHaveBeenCalled();
  });
  it("does not switch on 429, invalid input or missing configuration", async () => {
    for (const kind of ["RATE_LIMIT", "INVALID", "NOT_CONFIGURED"] as const) {
      const { router, primary, fallback } = setup();
      vi.mocked(primary.submit).mockRejectedValue(new ProviderFailure(kind, true, 2000));
      await expect(router.submit(shot, "key", ["gemini", "xai"])).rejects.toMatchObject({ kind });
      expect(fallback.submit).not.toHaveBeenCalled();
    }
  });
  it("trips circuit after three outages and reports health locally", async () => {
    const { router, primary } = setup();
    vi.mocked(primary.submit).mockRejectedValue(new ProviderFailure("OUTAGE", true));
    for (let i = 0; i < 3; i++)
      await expect(router.submit(shot, `key${i}`, ["gemini", "xai"])).rejects.toMatchObject({
        kind: "OUTAGE",
      });
    await router.submit(shot, "fallback", ["gemini", "xai"]);
    expect(primary.submit).toHaveBeenCalledTimes(3);
    expect(router.matrix()[0]!.health).toBe("UNAVAILABLE");
    expect(router.matrix()[1]!.health).toBe("HEALTHY");
  });
  it("rejects an empty route and honors capability fit", async () => {
    const { router } = setup();
    await expect(router.submit(shot, "key", [])).rejects.toMatchObject({ kind: "NOT_CONFIGURED" });
    await expect(
      router.submit({ ...shot, fps: 60 }, "key", ["gemini", "xai"]),
    ).rejects.toMatchObject({ kind: "NOT_CONFIGURED" });
  });
});
describe("provider limiter", () => {
  it("enforces concurrency and backoff then permits a later retry", async () => {
    let now = 0;
    const limiter = new ProviderLimiter(1, () => now);
    let release!: () => void;
    const active = limiter.run(
      secondsCost(8, omniRate),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(limiter.run(secondsCost(8, omniRate), async () => 1)).rejects.toMatchObject({
      kind: "RATE_LIMIT",
      dispatched: false,
    });
    release();
    await active;
    await expect(
      limiter.run(secondsCost(8, omniRate), async () => {
        throw new ProviderFailure("RATE_LIMIT", true, 5000);
      }),
    ).rejects.toMatchObject({ kind: "RATE_LIMIT" });
    await expect(limiter.run(secondsCost(8, omniRate), async () => 1)).rejects.toMatchObject({
      retryAfterMs: 5000,
    });
    now = 6000;
    expect(await limiter.run(secondsCost(8, omniRate), async () => 1)).toBe(1);
  });
  it("enforces RPM, daily and spend caps and forgets non-dispatched calls", async () => {
    let now = 0;
    const limiter = new ProviderLimiter(1, () => now);
    for (let i = 0; i < 8; i++) await limiter.run(secondsCost(1, 1), async () => 1);
    await expect(limiter.run(secondsCost(1, 1), async () => 1)).rejects.toMatchObject({
      kind: "RATE_LIMIT",
    });
    for (let i = 8; i < 40; i++) {
      now += 60001;
      await limiter.run(secondsCost(1, 1), async () => 1);
    }
    now += 60001;
    await expect(limiter.run(secondsCost(1, 1), async () => 1)).rejects.toMatchObject({
      kind: "RATE_LIMIT",
    });
    now += 32 * 86400000;
    await expect(limiter.run(secondsCost(1, 10000001), async () => 1)).rejects.toMatchObject({
      kind: "RATE_LIMIT",
    });
    await expect(
      limiter.run(secondsCost(1, 1), async () => {
        throw new ProviderFailure("INVALID", false);
      }),
    ).rejects.toMatchObject({ dispatched: false });
    expect(await limiter.run(secondsCost(1, 1), async () => 1, false)).toBe(1);
  });
});
describe("exact catalog and money", () => {
  it("keeps sub-cent rates exact until reservation rounding", () => {
    expect(secondsCost(8, omniRate)).toEqual({ currency: "USD", microUsd: 556032 });
    expect(ledgerUsd(secondsCost(8, omniRate))).toBe("0.556032");
    expect(reservationCents(secondsCost(8, omniRate))).toBe(56);
    expect(ledgerUsd(secondsCost(0.001, omniRate))).toBe("0.000070");
    for (const bad of [-1, NaN, Infinity, 0.0001])
      expect(() => secondsCost(bad, omniRate)).toThrow();
    expect(() => secondsCost(1, -1)).toThrow();
    expect(() => secondsCost(Number.MAX_SAFE_INTEGER, 1000000)).toThrow();
    expect(() => ledgerUsd({ currency: "USD", microUsd: 0.5 })).toThrow();
    for (const row of catalog) expect(ProviderCapabilitySchema.safeParse(row).success).toBe(true);
    expect(catalog[0]).toMatchObject({
      maxReferenceImages: 6,
      maxExtensionSeconds: 30,
      pricePerSecond: { "720p": 69504 },
    });
    expect(catalog[5]).toMatchObject({
      maxReferenceImages: 14,
      pricePerSecond: { "720p": 140000 },
    });
  });
  it("loads model IDs and credentials from the supplied environment", () => {
    const env = {
      GEMINI_VIDEO_MODEL: models.video,
      GEMINI_IMAGE_MODEL: models.image,
      GEMINI_TEXT_MODEL: models.text,
      GEMINI_TTS_MODEL: models.tts,
      GEMINI_MUSIC_MODEL: models.music,
      XAI_VIDEO_MODEL: models.xaiVideo,
    };
    expect(providerModels(env)).toEqual(models);
    expect(() => providerModels({})).toThrow();
    expect(providerKey("gemini", { NODE_ENV: "test", GEMINI_API_KEY: "secret" })).toBe("secret");
    expect(providerKey("gemini", { GEMINI_API_KEY: " secret " })).toBe(" secret ");
    expect(providerKey("xai", { XAI_API_KEY: "secret" })).toBe("secret");
    expect(providerKey("xai", {})).toBeUndefined();
  });
});
describe("HTTP failure boundary", () => {
  it("discards error bodies, distinguishes status and rejects unsafe downloads", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const http = new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher);
    for (const [status, kind] of [
      [500, "OUTAGE"],
      [408, "OUTAGE"],
      [400, "INVALID"],
      [403, "REFUSAL"],
      [429, "RATE_LIMIT"],
    ] as const) {
      fetcher.mockResolvedValueOnce(json({ key: "secret" }, status, { "retry-after": "2" }));
      await expect(http.json("interactions", {})).rejects.toMatchObject({
        kind,
        http: { status },
        message: `Provider ${kind.toLowerCase().replace("_", " ")} (HTTP ${status})`,
        retryAfterMs: status === 429 ? 2000 : 0,
      });
    }
    await expect(http.bytes("http://localhost/secret")).rejects.toMatchObject({
      dispatched: false,
    });
    await expect(http.bytes("https://attacker.invalid/secret")).rejects.toMatchObject({
      dispatched: false,
    });
    await expect(
      new ProviderHttp("", "gemini", fetcher).json("interactions"),
    ).rejects.toMatchObject({ kind: "NOT_CONFIGURED" });
    fetcher.mockResolvedValueOnce(json([]));
    await expect(http.json("interactions")).rejects.toMatchObject({ kind: "INVALID" });
    fetcher.mockResolvedValueOnce(new Response("not-json"));
    await expect(http.json("interactions")).rejects.toMatchObject({ kind: "INVALID" });
    fetcher.mockResolvedValueOnce(new Response(""));
    await expect(http.bytes("https://storage.googleapis.com/a")).rejects.toMatchObject({
      kind: "INVALID",
    });
    expect(() => record(null)).toThrow();
    expect(() => requiredString("")).toThrow();
  });

  it.each([
    [400, "invalid_request", "INVALID", false],
    [400, "INVALID_ARGUMENT", "INVALID", false],
    [401, "UNAUTHENTICATED", "REFUSAL", false],
    [403, "permission_denied", "REFUSAL", false],
    [404, "NOT_FOUND", "INVALID", false],
    [400, "unlabeled-secret", "INVALID", true],
    [403, 403, "REFUSAL", true],
    [408, "invalid_request", "OUTAGE", true],
    [409, "invalid_request", "INVALID", true],
    [429, "RESOURCE_EXHAUSTED", "RATE_LIMIT", true],
    [503, "INVALID_ARGUMENT", "OUTAGE", true],
  ])("classifies HTTP %i with diagnostic %s", async (status, code, kind, dispatched) => {
    const fetcher = vi.fn<typeof fetch>();
    const http = new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher);
    fetcher.mockResolvedValueOnce(
      json(
        {
          error: {
            message: "Invalid request for alice@example.test: private prompt, key=other-secret",
            status:
              typeof code === "string" && code === code.toUpperCase() ? code : "another-secret",
            code,
            details: { code: "invalid_request" },
          },
        },
        status,
      ),
    );
    const allowed = typeof code === "string" && code !== "unlabeled-secret" ? code : undefined;
    const labels = {
      INVALID: "Provider invalid",
      REFUSAL: "Provider refusal",
      OUTAGE: "Provider outage",
      RATE_LIMIT: "Provider rate limit",
    };
    const error: unknown = await http.json("interactions").catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProviderFailure);
    expect(error).toMatchObject({
      kind,
      dispatched,
      message: `${labels[kind as keyof typeof labels]} (HTTP ${status}${allowed ? `, ${allowed}` : ""})`,
      retryAfterMs: status === 429 ? 1000 : 0,
    });
    expect((error as ProviderFailure).http).toEqual({
      status,
      ...(allowed ? { code: allowed } : {}),
    });
  });

  it.each(["large", "slow"])(
    "reads only a bounded prefix of a %s error response",
    async (mode) => {
      const fetcher = vi.fn<typeof fetch>();
      const http = new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher);
      const cancel = vi.fn();
      const pull = vi.fn(() => new Promise<void>(() => undefined));
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller): void {
            controller.enqueue(
              new TextEncoder().encode(
                '{"error":{"status":"INVALID_ARGUMENT","message":"' +
                  (mode === "large" ? "x".repeat(8192) : ""),
              ),
            );
          },
          pull,
          cancel,
        },
        { highWaterMark: 0 },
      );
      fetcher.mockResolvedValueOnce(new Response(body, { status: 400 }));
      await expect(http.json("interactions")).rejects.toMatchObject({
        dispatched: false,
        http: { status: 400, code: "INVALID_ARGUMENT" },
        message: "Provider invalid (HTTP 400, INVALID_ARGUMENT)",
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(pull).toHaveBeenCalledTimes(mode === "large" ? 0 : 1);
    },
    1000,
  );
});
