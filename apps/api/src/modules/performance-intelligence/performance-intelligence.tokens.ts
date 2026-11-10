import {
  InsightConnectorUnavailableError,
  NotConfiguredInsightReportLlm,
  type InsightReportLlmPort,
  type InsightNarrativeInput,
  type InsightNarrativeResult,
} from "./performance-intelligence.ports.js";

export const INSIGHT_REPORT_LLM = Symbol("INSIGHT_REPORT_LLM");

export { InsightConnectorUnavailableError, NotConfiguredInsightReportLlm };
export type { InsightReportLlmPort, InsightNarrativeInput, InsightNarrativeResult };
