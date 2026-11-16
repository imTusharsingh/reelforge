import { describe, expect, it, vi } from "vitest";
import {
  OpenAiIdeaProposalLlm,
  OpenAiInsightReportLlm,
  OpenAiQualityReviewPort,
  OpenAiScriptLlm,
} from "./openai.adapters.js";

const CORRELATION = "00000000-0000-4000-8000-000000000001";
const KEY = "sk-test-secret";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requestBody(fetcher: ReturnType<typeof vi.fn>): unknown {
  const init = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body));
}

const criterion = {
  score: 80,
  evidence: ["supported"],
  limitations: [],
};

describe("OpenAI adapters", () => {
  it("maps an idea proposal and sends the configured text model", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "chatcmpl_1",
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Title",
                topic: "Topic",
                hook: "Hook",
                angle: "Angle",
                audience: "Audience",
                expectedFormat: "short-form-video",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    );
    const result = await new OpenAiIdeaProposalLlm(KEY, "text-model", fetcher).proposeIdea({
      prompt: "pitch",
      context: "brand",
      correlationId: CORRELATION,
    });
    expect(result.proposal.title).toBe("Title");
    expect(result.proposal.references).toEqual([]);
    expect(result.metadata).toMatchObject({
      modelVersion: "text-model",
      promptVersion: "openai-chat-completions-v1",
      cost: null,
    });
    expect(requestBody(fetcher)).toMatchObject({
      model: "text-model",
      response_format: { type: "json_object" },
    });
    expect(JSON.stringify(requestBody(fetcher))).toContain("pitch");
    expect(JSON.stringify(requestBody(fetcher))).not.toContain(KEY);
  });

  it("rejects an idea response that does not match the proposal schema", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: '{"title":"only"}' } }] }));
    await expect(
      new OpenAiIdeaProposalLlm(KEY, "text-model", fetcher).proposeIdea({
        prompt: "pitch",
        correlationId: CORRELATION,
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN", providerCalled: true });
  });

  it("maps a script object and refuses a per-request model override before dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "chatcmpl_script",
        choices: [{ message: { content: '{"schemaVersion":"1.0","title":"T"}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    );
    const adapter = new OpenAiScriptLlm(KEY, "text-model", fetcher);
    const result = await adapter.complete({ prompt: "write JSON", correlationId: CORRELATION });
    expect(result.output).toMatchObject({ schemaVersion: "1.0", title: "T" });
    expect(result.providerRequestId).toBe("chatcmpl_script");
    expect(result.metadata.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    await expect(
      adapter.complete({ prompt: "write JSON", model: "other-model", correlationId: CORRELATION }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", providerCalled: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps a quality review and keeps adapter provenance instead of model metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "chatcmpl_quality",
        choices: [
          {
            message: {
              content: JSON.stringify({
                criteria: {
                  FACTUALITY: criterion,
                  CLARITY: criterion,
                  COHERENCE: criterion,
                  ENGAGEMENT: criterion,
                  GENRE_FIT: criterion,
                },
              }),
            },
          },
        ],
      }),
    );
    const result = await new OpenAiQualityReviewPort(KEY, "text-model", fetcher).review({
      correlationId: CORRELATION,
      title: "t",
      hook: "h",
      dialogue: "d",
      narration: "n",
      callToAction: "c",
      genre: "g",
      allowedTopics: [],
      blockedTopics: [],
      claims: [],
      scenes: [],
      requiredDisclosures: [],
    });
    expect(result.criteria.FACTUALITY.score).toBe(80);
    expect(result.metadata.modelVersion).toBe("text-model");
    expect(result.metadata.promptVersion).toBe("openai-chat-completions-v1");
  });

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
