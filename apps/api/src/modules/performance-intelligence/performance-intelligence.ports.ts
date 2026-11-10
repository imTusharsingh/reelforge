import type { CapabilityMetadata, ProviderProvenance } from "@reelforge/ai-providers";
import type {
  PerformanceDimensionSummary,
  PerformanceKpiResult,
  PerformanceWindow,
} from "@reelforge/contracts";

export type InsightNarrativeInput = Readonly<{
  channelId: string;
  currentWindow: PerformanceWindow;
  previousWindow: PerformanceWindow;
  kpis: readonly PerformanceKpiResult[];
  dimensions: readonly PerformanceDimensionSummary[];
}>;

export type InsightNarrativeResult = Readonly<{
  narrative: string;
  provenance: ProviderProvenance;
}>;

/**
 * M08-shaped LLM port for evidence-linked insight narratives. The default
 * implementation is fail-closed; tests inject fixtures and no live provider is
 * called in startup, health checks, CI, or tests.
 */
export interface InsightReportLlmPort {
  readonly capability: CapabilityMetadata;
  isConfigured(): boolean;
  generate(input: InsightNarrativeInput): Promise<InsightNarrativeResult>;
}

export class InsightConnectorUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InsightConnectorUnavailableError";
  }
}

export class NotConfiguredInsightReportLlm implements InsightReportLlmPort {
  public readonly capability: CapabilityMetadata = {
    providerId: "unconfigured",
    capabilityId: "insight-report-llm",
    kind: "llm",
    input: ["text"],
    output: ["text"],
    supportsReferenceImages: false,
    asynchronous: false,
    polling: false,
    regions: [],
    costModel: { currency: "USD", unit: "request", amount: null },
  };

  public isConfigured(): boolean {
    return false;
  }

  public generate(): Promise<InsightNarrativeResult> {
    return Promise.reject(
      new InsightConnectorUnavailableError("Insight report LLM is not configured"),
    );
  }
}
