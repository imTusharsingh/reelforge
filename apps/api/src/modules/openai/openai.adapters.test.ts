import { describe, expect, it, vi } from "vitest";
import { OpenAiInsightReportLlm } from "./openai.adapters.js";

const CORRELATION = "00000000-0000-4000-8000-000000000001";
const KEY = "sk-test-secret";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("OpenAI adapters", () => {
  it("maps an insight narrative and rejects a response without one", async () => {
    const ok = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ choices: [{ message: { content: '{"narrative":"Views fell."}' } }] }),
      );
    const narrative = await new OpenAiInsightReportLlm(KEY, "text-model", ok).generate({
      correlationId: CORRELATION,
      channelId: "channel",
      currentWindow: { startDate: "2026-01-01", endDate: "2026-01-07" },
      previousWindow: { startDate: "2025-12-25", endDate: "2025-12-31" },
      kpis: [],
      dimensions: [],
    });
    expect(narrative.narrative).toBe("Views fell.");
    const bad = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: '{"note":"no"}' } }] }));
    await expect(
      new OpenAiInsightReportLlm(KEY, "text-model", bad).generate({
        correlationId: CORRELATION,
        channelId: "channel",
        currentWindow: { startDate: "2026-01-01", endDate: "2026-01-07" },
        previousWindow: { startDate: "2025-12-25", endDate: "2025-12-31" },
        kpis: [],
        dimensions: [],
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
  });
});
