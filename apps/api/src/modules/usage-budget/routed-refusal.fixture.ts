import { randomUUID } from "node:crypto";
import type { VideoGenPort } from "@reelforge/ai-providers";
import { ProviderLedger } from "../openai/provider-ledger.js";
import { artifact, catalog, shot } from "../openai/provider.fixture.js";
import type { Tenant } from "../runs/runs.fixture.js";

export async function refusedRoutedJob(t: Tenant): Promise<{
  requestId: string;
  correlationId: string;
  replay: () => Promise<void>;
  bill: (cents: number) => Promise<void>;
}> {
  const { workspaceId, channelId } = t.run;
  const correlationId = randomUUID();
  const ledger = new ProviderLedger(t.db, t.usage);
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
    bill: (cents) =>
      ledger.finish(workspaceId, correlationId, port, { ...artifact, billedSeconds: cents }, jobId),
  };
}
