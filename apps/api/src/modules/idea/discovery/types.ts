import type { z } from "zod";
import type { DiscoverySourceSchema, DiscoveryWeights } from "@reelforge/contracts";
export type DiscoverySource = z.infer<typeof DiscoverySourceSchema>;
export type LearningSample = {
  videoId: string;
  formatKey: string;
  retention: number;
  factors: DiscoveryWeights;
  evidenceSnapshotIds: string[];
};
