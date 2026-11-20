import { describe, expect, it, vi } from "vitest";
import type { ArtifactStore } from "./ports.js";
import { ProviderHttp } from "./http.js";

import { Interactions } from "./interactions.js";
import { OmniVideo, GrokVideo } from "./video.js";
import { NanoBanana, GeminiTts, LyriaMusic } from "./media.js";
import { GeminiText } from "./text.js";
import { artifact, catalog, completed, json, shot } from "./provider.fixture.js";

function fixture(): {
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  store: { save: ReturnType<typeof vi.fn<ArtifactStore["save"]>> };
  client: Interactions;
} {
  const fetcher = vi.fn<typeof fetch>();
  const store = { save: vi.fn<ArtifactStore["save"]>().mockResolvedValue(artifact) };
  return {
    fetcher,
    store,
    client: new Interactions(
      new ProviderHttp("AIza" + "aB1".repeat(12), "gemini", fetcher, 5),
      store,
    ),
  };
}
describe("Gemini media fake-fetch contracts", () => {
  it.each(["omni", "image", "tts", "music"])(
    "%s submit, poll, fetch, refusal and timeout",
    async (kind) => {
      const { client, fetcher, store } = fixture();
      const port =
        kind === "omni"
          ? new OmniVideo(client, catalog[0]!, { resolve: async (): Promise<[]> => [] })
          : kind === "image"
            ? new NanoBanana(client, "configured-image")
            : kind === "tts"
              ? new GeminiTts(client, "configured-tts")
              : new LyriaMusic(client, "configured-music");
      const submit = (): Promise<{ providerJobId: string }> =>
        kind === "omni"
          ? (port as OmniVideo).submit(shot, "idem")
          : kind === "image"
            ? (port as NanoBanana).submit({ prompt: "pond" }, "idem")
            : kind === "tts"
              ? (port as GeminiTts).submit({ text: "hello", voice: "Kore" }, "idem")
              : (port as LyriaMusic).submit(
                  { prompt: "quiet strings", durationSeconds: 8, instrumentalOnly: true },
                  "idem",
                );
      fetcher.mockResolvedValueOnce(json({ id: "job", status: "queued" }));
      expect(await submit()).toEqual({ providerJobId: "job" });
      const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
      expect(body).toMatchObject({ background: true, store: true });
      expect(JSON.stringify(body)).not.toContain("secret");
      if (kind === "omni")
        expect(body.response_format).toMatchObject({
          delivery: "uri",
          duration: "8s",
          aspect_ratio: "9:16",
        });
      if (kind === "music") expect(body.input).toContain("Instrumental only");
      fetcher.mockResolvedValueOnce(json({ status: "in_progress" }));
      expect(await port.poll("job")).toBe("running");
      fetcher.mockResolvedValueOnce(
        json(completed(kind === "image" ? "image" : kind === "omni" ? "video" : "audio")),
      );
      expect(await (port as NanoBanana).fetch("job", 8)).toMatchObject({
        checksumSha256: "hash",
        billedSeconds: 8,
      });
      expect(store.save).toHaveBeenCalled();
      fetcher.mockResolvedValueOnce(json({ status: "refused" }));
      await expect(submit()).rejects.toMatchObject({ kind: "REFUSAL" });
      fetcher.mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      );
      await expect(submit()).rejects.toMatchObject({ kind: "OUTAGE", dispatched: true });
    },
  );
  it("downloads URI delivery without leaking credentials to storage origins", async () => {
    const { client, fetcher } = fixture();
    fetcher
      .mockResolvedValueOnce(
        json({
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [
                {
                  type: "video",
                  mime_type: "video/mp4",
                  uri: "https://storage.googleapis.com/bucket/video",
                },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response("abc"));
    await expect(client.fetch("job", "video")).resolves.toMatchObject({ billedSeconds: null });
    expect(fetcher.mock.calls[1]![1]!.headers).toEqual({ "Api-Revision": "2026-05-20" });
  });
  it("validates media requests before dispatch", async () => {
    const { client, fetcher } = fixture();
    const omni = new OmniVideo(client, catalog[0]!, { resolve: async (): Promise<[]> => [] });
    expect(omni.capabilities()).toEqual(catalog[0]);
    expect(omni.estimate(shot)).toEqual({ currency: "USD", microUsd: 556032 });
    await expect(omni.submit({ ...shot, fps: 30 }, "key")).rejects.toMatchObject({
      dispatched: false,
    });
    await expect(
      omni.submit({ ...shot, firstFrameFrom: { previousShotOrdinal: 0 }, ordinal: 1 }, "key"),
    ).rejects.toMatchObject({ dispatched: false });
    await expect(
      omni.submit(shot, "key", { extension: { providerJobId: "old", previousSeconds: 29 } }),
    ).rejects.toMatchObject({ dispatched: false });
    expect(() => new NanoBanana(client, "model").submit({ prompt: "" }, "key")).toThrow();
    expect(() => new GeminiTts(client, "model").submit({ text: "hi", voice: "" }, "key")).toThrow();
    expect(() =>
      new LyriaMusic(client, "model").submit(
        { prompt: "music", durationSeconds: -1, instrumentalOnly: true },
        "key",
      ),
    ).toThrow();
    expect(() => new LyriaMusic(client, "model").fetch("job")).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe("xAI fake-fetch contract", () => {
  it("submits by request_id, polls, fetches, refuses and times out", async () => {
    const { fetcher, store } = fixture();
    const port = new GrokVideo(
      new ProviderHttp("xai-" + "bC2".repeat(12), "xai", fetcher, 5),
      store,
      catalog[5]!,
      { resolve: async (): Promise<[]> => [] },
    );
    expect(port.capabilities()).toEqual(catalog[5]);
    expect(port.estimate(shot).microUsd).toBe(1120000);
    fetcher.mockResolvedValueOnce(json({ request_id: "request" }));
    expect(await port.submit(shot, "key")).toEqual({ providerJobId: "request" });
    fetcher
      .mockResolvedValueOnce(json({ status: "pending" }))
      .mockResolvedValueOnce(json({ status: "failed" }))
      .mockResolvedValueOnce(json({ status: "done", video: { respect_moderation: false } }));
    expect(await port.poll("request")).toBe("running");
    expect(await port.poll("request")).toBe("failed");
    expect(await port.poll("request")).toBe("refused");
    fetcher.mockResolvedValueOnce(json({ status: "done", video: { respect_moderation: true } }));
    expect(await port.poll("request")).toBe("succeeded");
    fetcher
      .mockResolvedValueOnce(
        json({
          status: "done",
          video: { url: "https://vidgen.x.ai/video.mp4", duration: 8, respect_moderation: true },
        }),
      )
      .mockResolvedValueOnce(new Response("abc"));
    expect(await port.fetch("request")).toMatchObject({ billedSeconds: 8 });
    expect(fetcher.mock.calls.at(-1)![1]!.headers).not.toHaveProperty("Authorization");
    fetcher.mockResolvedValueOnce(json({ status: "done", video: { respect_moderation: false } }));
    await expect(port.fetch("request")).rejects.toMatchObject({ kind: "REFUSAL" });
    fetcher.mockResolvedValueOnce(json({}, 403));
    await expect(port.submit(shot, "key")).rejects.toMatchObject({ kind: "REFUSAL" });
    fetcher.mockRejectedValueOnce(new Error("timeout"));
    await expect(port.submit(shot, "key")).rejects.toMatchObject({ kind: "OUTAGE" });
    await expect(
      port.submit(shot, "key", { extension: { providerJobId: "old", previousSeconds: 8 } }),
    ).rejects.toMatchObject({ dispatched: false });
  });
});
describe("Gemini structured multimodal text", () => {
  it("supports direct and async submit/poll/fetch, refusal, schema rejection and timeout", async () => {
    const { client, fetcher } = fixture();
    const port = new GeminiText(client, "configured-text");
    const response = {
      id: "text-job",
      status: "completed",
      usage: { input_tokens: 10 },
      steps: [{ type: "model_output", content: [{ type: "text", text: '{"score":8}' }] }],
    };
    const spec = {
      prompt: "critique",
      systemPrompt: "be precise",
      grounding: true,
      media: [{ type: "image" as const, mime_type: "image/png", data: "YWJj" }],
      jsonSchema: { type: "object" },
      parse: (value: unknown): unknown => value,
    };
    fetcher.mockResolvedValueOnce(json(response));
    expect(await port.complete(spec, "key")).toMatchObject({
      output: { score: 8 },
      providerJobId: "text-job",
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({
      background: false,
      tools: [{ type: "google_search" }],
    });
    fetcher
      .mockResolvedValueOnce(json({ id: "job", status: "queued" }))
      .mockResolvedValueOnce(json({ status: "queued" }))
      .mockResolvedValueOnce(json(response));
    expect(await port.submit(spec, "key")).toEqual({ providerJobId: "job" });
    expect(await port.poll("job")).toBe("queued");
    expect(await port.fetch("job", spec.parse)).toMatchObject({ output: { score: 8 } });
    fetcher.mockResolvedValueOnce(json({ status: "refused" }));
    await expect(port.complete(spec, "key")).rejects.toMatchObject({ kind: "REFUSAL" });
    fetcher.mockResolvedValueOnce(json(response));
    await expect(
      port.complete(
        {
          ...spec,
          parse: (): never => {
            throw new Error("schema");
          },
        },
        "key",
      ),
    ).rejects.toMatchObject({ kind: "INVALID" });
    fetcher.mockRejectedValueOnce(new Error("timeout"));
    await expect(port.complete(spec, "key")).rejects.toMatchObject({ kind: "OUTAGE" });
    await expect(port.submit({ ...spec, prompt: "" }, "key")).rejects.toMatchObject({
      dispatched: false,
    });
  });
});

describe("provider HTTP key validation", () => {
  it.each([
    ["gemini", "AIza"],
    ["gemini", "AQ."],
    ["xai", "xai-"],
  ] as const)("validates %s credentials before fetch for %s keys", async (vendor, prefix) => {
    const key = prefix + "aB1".repeat(12);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "fixture-job" }));
    for (const malformed of [
      " ",
      ` ${key}`,
      `${key}\n`,
      prefix + "aB1 ".repeat(12),
      prefix + "fake" + key,
      prefix + "placeholder".repeat(3),
      prefix + "your-key".repeat(3),
      prefix + "xxx".repeat(10),
      prefix + "changeme".repeat(4),
      prefix + "0".repeat(36),
      "wrong-" + key,
      prefix + "short",
    ]) {
      await expect(
        new ProviderHttp(malformed, vendor, fetcher).json("fixture", {}),
      ).rejects.toMatchObject({ kind: "INVALID_KEY", dispatched: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    await expect(new ProviderHttp(key, vendor, fetcher).json("fixture", {})).resolves.toEqual({
      id: "fixture-job",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
