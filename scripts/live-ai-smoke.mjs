const enabled = process.env.LIVE_AI_SMOKE === "1";
const key = process.env.OPENAI_API_KEY?.trim();
if (!enabled) throw new Error("Set LIVE_AI_SMOKE=1 to run the manual OpenAI smoke.");
if (!key) throw new Error("OPENAI_API_KEY is required for the manual OpenAI smoke.");

const model = process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini";
const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: 'Return exactly {"smoke":true} as JSON.' }],
    response_format: { type: "json_object" },
    max_tokens: 8,
  }),
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw new Error(`OpenAI smoke failed with HTTP ${response.status}`);
const body = await response.json();
if (body?.choices?.[0]?.message?.content !== '{"smoke":true}')
  throw new Error("OpenAI smoke returned an unexpected response.");
console.log(`OpenAI text smoke passed for model ${model}; no secret or response body was logged.`);
