import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoragePort } from "../asset/storage/storage.port.js";
import type { ProviderKeys } from "./provider-keys.js";
import type { ProviderLedger } from "./provider-ledger.js";
import { ProvidersRuntime } from "./providers.runtime.js";
import { shot, artifact } from "./provider.fixture.js";
import { ProviderFailure } from "@reelforge/ai-providers";
afterEach(() => vi.unstubAllEnvs());
describe("registered provider runtime", () => {
  it("constructs all configured ports offline and wraps dispatch with ledger and limiter", async () => {
    for (const name of ["VIDEO", "IMAGE", "TEXT", "TTS", "MUSIC"])
      vi.stubEnv(`GEMINI_${name}_MODEL`, name.toLowerCase());
    vi.stubEnv("XAI_VIDEO_MODEL", "fallback");
    const keys = { resolve: vi.fn().mockResolvedValue("fixture-secret") };
    const ledger = {
      submit: vi.fn().mockResolvedValue({ providerJobId: "job" }),
      finish: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new ProvidersRuntime(
      keys as unknown as ProviderKeys,
      ledger as unknown as ProviderLedger,
      {} as StoragePort,
    );
    const context = { workspaceId: shot.workspaceId, userId: "owner", role: "OWNER" as const };
    const refs = { resolve: vi.fn().mockResolvedValue([]) };
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live forbidden"));
    const ports = await runtime.ports(context, refs);
    expect(Object.keys(ports)).toEqual(["omni", "grok", "image", "text", "tts", "music"]);
    expect(fetcher).not.toHaveBeenCalled();
    const allow = vi.fn().mockResolvedValue(undefined);
    const router = await runtime.router(context, null, refs, async (spec) => spec, allow);
    const job = await router.submit(shot, "run:shot:1", ["gemini", "xai"]);
    expect(job.providerJobId).toBe("job");
    expect(ledger.submit).toHaveBeenCalledWith(
      expect.anything(),
      shot,
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      null,
      "run:shot:1:gemini",
    );
    await expect(
      router.submit({ ...shot, workspaceId: "other" }, "other", ["gemini", "xai"]),
    ).rejects.toThrow("Cross-workspace");
    ledger.submit.mockRejectedValueOnce(new ProviderFailure("OUTAGE", true));
    await router.submit(shot, "run:shot:2", ["gemini", "xai"]);
    expect(allow).toHaveBeenCalled();
    vi.spyOn(ports.omni, "fetch").mockResolvedValue(artifact);
    await runtime.reconcile(context.workspaceId, "run:shot:1:gemini", ports.omni, "job");
    expect(ledger.finish).toHaveBeenCalledWith(
      context.workspaceId,
      expect.any(String),
      ports.omni,
      artifact,
    );
    fetcher.mockRestore();
  });
});
