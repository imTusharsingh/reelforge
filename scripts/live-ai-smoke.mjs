/**
 * Manual OpenAI text smoke. Not part of `pnpm test` or CI.
 * Requires LIVE_AI_SMOKE=1 and OPENAI_API_KEY. One Chat Completions call,
 * hard-capped at 16 completion tokens. Does not call images, speech, or video.
 * The owner must authorize the run. The key and response body are not printed.
 */
const MAX_COMPLETION_TOKENS = 16;
const enabled = process.env.LIVE_AI_SMOKE === "1";
const key = process.env.OPENAI_API_KEY?.trim();
if (!enabled) throw new Error("Set LIVE_AI_SMOKE=1 to run the manual OpenAI smoke.");
if (!key) throw new Error("OPENAI_API_KEY is required for the manual OpenAI smoke.");

const model = process.env.OPENAI_TEXT_MODEL?.trim() || "gpt-4.1-mini";
const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: 'Return JSON only: {"smoke":true}',
      },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: MAX_COMPLETION_TOKENS,
  }),
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw new Error(`OpenAI smoke failed with HTTP ${response.status}`);
const body = await response.json();
const content = body?.choices?.[0]?.message?.content;
if (content !== '{"smoke":true}') throw new Error("OpenAI smoke returned an unexpected response.");
console.log(
  `OpenAI text smoke passed for model ${model} with a ${MAX_COMPLETION_TOKENS}-token cap; no secret or response body was logged.`,
);
