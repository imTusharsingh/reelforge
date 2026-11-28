import { GeminiText, Interactions, ProviderHttp } from "@reelforge/ai-providers";
import { MediaReceiptSchema } from "@reelforge/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { planningFixture, scriptFixture, shotsFixture } from "../script/planning.fixture.js";
import { bindMedia } from "./media-bindings.fixture.js";
import { fakeMediaPorts } from "./media-recovery.fixture.js";

const narrator = {
  providerId: "gemini" as const,
  voiceId: "fixture-voice",
  language: "English",
  pace: 1,
};
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/xsAAwMCAO+/p1sAAAAASUVORK5CYII=",
  "base64",
);
const roles = ["scriptwriter", "director", "art-director"] as const;

function completed(value: unknown, id: string | null): Response {
  return Response.json({
    ...(id === null ? {} : { id }),
    status: "completed",
    usage: { total_input_tokens: 25, total_output_tokens: 10 },
    steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(value) }] }],
  });
}

describe.skipIf(!process.env.DATABASE_URL)("exported planning text receipts", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());

  it.each([false, true])(
    "saves planning receipts with a local dispatch reference (script repair: %s)",
    async (repair) => {
      vi.stubEnv("GEMINI_TEXT_MODEL", "fixture-text");
      vi.stubEnv("GEMINI_IMAGE_MODEL", "fixture-image");
      const t = await fixture.tenant("L2", 30, narrator, false);
      const script = scriptFixture();
      const shots = shotsFixture({ ...planningFixture(), runId: t.run.id, brief: t.brief }).map(
        (shot) => ({ ...shot, workspaceId: t.context.workspaceId, durationSeconds: 5 }),
      );
      const native = fakeMediaPorts(
        t.context.workspaceId,
        t.storage,
        { image, audio: Buffer.alloc(0), clip: Buffer.alloc(0) },
        [],
      );
      const http = vi.fn<typeof fetch>();
      if (repair)
        http.mockResolvedValueOnce(completed({ ...script, hook: "leaf ".repeat(11) }, null));
      http
        .mockResolvedValueOnce(completed(script, null))
        .mockResolvedValueOnce(completed(shots, "google-director"))
        .mockResolvedValueOnce(
          completed(
            { character: null, styleFrame: "Leaves", keyframePrompts: shots.map(() => "Leaf") },
            null,
          ),
        );
      native.text = new GeminiText(
        new Interactions(
          new ProviderHttp(
            "AIza" + "abc".repeat(12),
            "gemini",
            http,
            undefined,
            async (url, init, sent) => {
              await sent();
              return http(url, { ...init, method: "POST" });
            },
          ),
          {
            save: async (): Promise<never> => {
              throw new Error("Text response must not fetch a provider artifact");
            },
          },
        ),
        "fixture-text",
      );
      const { planning } = bindMedia(t, native);
      await t.engine.process(t.runs.job(t.context, t.run.id));
      const run = await t.store.get(t.context, t.run.id);
      expect(run.state).toBe("SCRIPTING");
      const result = await planning.plan(t.context, run, t.brief);
      expect(result.script).toEqual(script);
      expect(result.manifest.shots).toHaveLength(6);

      for (const [index, role] of roles.entries()) {
        const key = `media:text:${role}`;
        const step = await t.db.videoRunStep.findFirstOrThrow({
          where: { runId: run.id, key, state: "SUCCEEDED" },
        });
        expect(step.state).toBe("SUCCEEDED");
        const receipt = MediaReceiptSchema.parse(
          (step.output as { result: { receipt: unknown } }).result.receipt,
        );
        expect(receipt).toMatchObject({
          key,
          dispatchKey: step.idempotencyKey,
          providerJobId: role === "director" ? "google-director" : null,
          costBasis: "RESERVATION",
          costMinor: step.costMinor,
        });
        const init = http.mock.calls[index + Number(repair)]?.[1];
        expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(receipt.dispatchKey);
        expect(JSON.parse(String(init?.body))).toMatchObject({ store: false });
      }

      expect(await planning.plan(t.context, run, t.brief)).toEqual(result);
      expect(http).toHaveBeenCalledTimes(3 + Number(repair));
      if (repair) {
        expect(String(http.mock.calls[1]![1]?.body)).toContain("at most 10 words");
        const writers = await t.db.videoRunStep.findMany({
          where: { runId: run.id, key: "media:text:scriptwriter" },
          orderBy: { attempt: "asc" },
        });
        expect(writers).toMatchObject([
          { state: "FAILED", costMinor: 17 },
          { state: "SUCCEEDED", costMinor: 17 },
        ]);
        expect(writers[0]!.idempotencyKey).not.toBe(writers[1]!.idempotencyKey);
        expect(
          await t.db.usageReservation.findMany({
            where: { correlationId: { in: writers.map((step) => step.id) } },
          }),
        ).toMatchObject(Array(2).fill({ status: "COMMITTED", committedMinor: 17n }));
      }
    },
  );
});
