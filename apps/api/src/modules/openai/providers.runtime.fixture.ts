import { vi } from "vitest";
import type { VideoRoutingState } from "@reelforge/ai-providers";
import type { Tenant } from "../runs/runs.fixture.js";
import type { ProviderKeys } from "./provider-keys.js";
import type { ProviderVideoHealth } from "./provider-video-health.js";
import { ProviderLedger } from "./provider-ledger.js";
import { ProvidersRuntime } from "./providers.runtime.js";

export function fixtureRuntime(t: Tenant, state: VideoRoutingState): ProvidersRuntime {
  vi.stubEnv("GEMINI_VIDEO_MODEL", "omni-fixture");
  for (const name of ["IMAGE", "TEXT", "TTS", "MUSIC"])
    vi.stubEnv(`GEMINI_${name}_MODEL`, name.toLowerCase());
  vi.stubEnv("XAI_VIDEO_MODEL", "xai-fixture");
  const keys = {
    resolve: async (_context: unknown, vendor: string): Promise<string> =>
      vendor === "gemini" ? "AIza" + "aB1".repeat(12) : "xai-" + "bC2".repeat(12),
  };
  return new ProvidersRuntime(
    keys as unknown as ProviderKeys,
    new ProviderLedger(t.db, t.usage),
    {
      state: async () => state,
      record: async () => undefined,
    } as unknown as ProviderVideoHealth,
    t.storage,
  );
}
