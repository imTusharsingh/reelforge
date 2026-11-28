import { createHash, randomUUID } from "node:crypto";
import type { VideoGenPort } from "@reelforge/ai-providers";
import { ProvidersRuntime } from "../openai/providers.runtime.js";
import { ProviderLedger } from "../openai/provider-ledger.js";
import { artifact, catalog, shot } from "../openai/provider.fixture.js";
import type { Tenant } from "../runs/runs.fixture.js";

export async function refusedRoutedJob(t: Tenant): Promise<{
  requestId: string;
  correlationId: string;
  replay: () => Promise<void>;
  bill: (cents: number) => Promise<void>;
  reconcile: (cents: number, failDownload?: boolean) => Promise<void>;
}> {
  const { workspaceId, channelId } = t.run;
  const key = `${randomUUID()}:gemini`;
  const hash = createHash("sha256").update(key).digest("hex");
  const correlationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const ledger = new ProviderLedger(t.db, t.usage);
  const runtime = new ProvidersRuntime(undefined!, ledger, undefined!, t.storage);
  const jobId = "fixture-refused-job";
  const port: VideoGenPort = {
    capabilities: () => ({
      ...catalog[0]!,
      modelId: "omni-fixture",
      pricePerSecond: { ...catalog[0]!.pricePerSecond, "720p": 10000 },
    }),
    estimate: () => ({ currency: "USD", microUsd: 200000 }),
    submit: async () => ({ providerJobId: jobId }),
    poll: async () => "refused",
    fetch: async () => artifact,
  };
  await ledger.submit(port, { ...shot, workspaceId }, correlationId, channelId, correlationId, {
    lock: correlationId,
    correlations: [correlationId],
  });
  const replay = (): Promise<void> => ledger.confirmRefusal(workspaceId, correlationId, jobId);
  await replay();
  const request = await t.db.providerRequest.findUniqueOrThrow({
    where: { workspaceId_correlationId: { workspaceId, correlationId } },
  });
  return {
    requestId: request.id,
    correlationId,
    replay,
    reconcile: (cents, failDownload): Promise<void> => {
      const source: VideoGenPort = {
        ...port,
        fetch: async (_id, record) => {
          await record?.(cents);
          if (failDownload) throw new Error("media download failed");
          return { ...artifact, billedSeconds: cents };
        },
      };
      return runtime.reconcile(workspaceId, key, source, jobId);
    },
    bill: (cents) =>
      ledger.finish(workspaceId, correlationId, port, { ...artifact, billedSeconds: cents }, jobId),
  };
}
