// Manual paid operation: one 8-second 9:16 Omni clip, about $0.56 plus input tokens.
// Requires separate owner authorization. Never invoked by test, startup, seed or CI.
import { mkdir, writeFile } from "node:fs/promises";
if (process.env.LIVE_AI_SMOKE !== "1" || process.env.CI)
  throw new Error("Manual use only: set LIVE_AI_SMOKE=1 after owner authorization.");
const key = process.env.GEMINI_API_KEY?.trim();
const model = process.env.GEMINI_VIDEO_MODEL?.trim();
if (!key || !model) throw new Error("GEMINI_API_KEY and GEMINI_VIDEO_MODEL are required.");
const headers = {
  "x-goog-api-key": key,
  "Content-Type": "application/json",
  "Api-Revision": "2026-05-20",
};
const base = "https://generativelanguage.googleapis.com/v1beta/";
async function json(path, body) {
  const response = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Omni smoke HTTP ${response.status}; no automatic resubmit.`);
  return response.json();
}
let job = await json("interactions", {
  model,
  input:
    "Single continuous shot of a paper boat floating on a quiet pond. No people, brands, dialogue or music.",
  background: true,
  store: true,
  response_format: {
    type: "video",
    delivery: "uri",
    duration: "8s",
    aspect_ratio: "9:16",
    resolution: "720p",
  },
});
if (typeof job.id !== "string")
  throw new Error("No interaction id; reconcile manually before retrying.");
await mkdir("work/omni-smoke", { recursive: true });
await writeFile("work/omni-smoke/job.json", JSON.stringify({ id: job.id, model }));
const deadline = Date.now() + 15 * 60000;
while (["queued", "in_progress"].includes(job.status) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10000));
  job = await json(`interactions/${encodeURIComponent(job.id)}`);
}
if (job.status !== "completed")
  throw new Error("Omni smoke incomplete; job id saved for reconciliation.");
const video = job.steps
  ?.filter((step) => step.type === "model_output")
  .flatMap((step) => step.content)
  .find((part) => part.type === "video");
let bytes;
if (video?.uri) {
  const url = new URL(video.uri);
  if (url.origin !== new URL(base).origin) throw new Error("Unexpected media origin.");
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Media download failed.");
  bytes = new Uint8Array(await response.arrayBuffer());
} else if (video?.data) bytes = Buffer.from(video.data, "base64");
if (!bytes?.length) throw new Error("No video bytes returned.");
await writeFile("work/omni-smoke/clip.mp4", bytes);
console.log("One Omni clip saved to work/omni-smoke/clip.mp4; run ffprobe before accepting it.");
