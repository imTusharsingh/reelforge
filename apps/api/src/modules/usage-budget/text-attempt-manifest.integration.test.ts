import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  importHistoricalBooking,
  readManifest,
} from "../composition/historical-text-receipt.fixture.js";
import { setupAssembly } from "../composition/media-assembly.fixture.js";
import { runsFixture } from "../runs/runs.fixture.js";
import { json } from "../runs/runs.types.js";

const fixture = runsFixture();
afterEach(() => vi.unstubAllEnvs());

it.skipIf(!process.env.DATABASE_URL)(
  "rebuilds a published text receipt when a same-price bill verifies its estimate",
  async () => {
    const setup = await setupAssembly(fixture);
    const { t, run, bindings, plan } = setup;
    const { workspaceId } = run;
    const scope = { workspaceId, runId: run.id };
    vi.stubEnv("GEMINI_TTS_MODEL", "fixture-TTS");
    vi.stubEnv("GEMINI_MUSIC_MODEL", "fixture-music");
    const prompt = {
      role: "scriptwriter" as const,
      version: 2 as const,
      templateVersionId: randomUUID(),
      promptSnapshotId: randomUUID(),
      configSnapshotId: randomUUID(),
      fingerprintSha256: "a".repeat(64),
    };
    vi.mocked(bindings.planning.saved).mockResolvedValue({
      ...plan,
      manifest: { ...plan.manifest, prompts: [prompt] },
    });
    await t.db.videoRunStep.create({
      data: {
        ...scope,
        key: "ASSEMBLING",
        state: "RUNNING",
        idempotencyKey: `${run.id}:ASSEMBLING:1`,
        input: {},
      },
    });
    const key = "media:text:scriptwriter";
    const dispatchKey = `${run.id}:${key}:1`;
    const providerJobId = "historical-google-id";
    const source = await t.artifacts.put(t.context, "refs", Buffer.from("{}"), "application/json");
    const { id: attemptId } = await t.db.videoRunStep.create({
      data: {
        ...scope,
        key,
        state: "SUCCEEDED",
        providerId: "gemini",
        providerJobId,
        idempotencyKey: dispatchKey,
        input: {},
        costMinor: 7,
        output: json({
          result: {
            output: plan.script,
            dispatchKey,
            receipt: {
              key,
              providerId: "gemini",
              providerJobId,
              dispatchKey,
              modelId: "fixture-text",
              promptVersion: "scriptwriter:v2",
              seconds: 0,
              costMinor: 7,
              costBasis: "RESERVATION",
              objectKey: source.objectKey,
              checksumSha256: source.checksumSha256,
              mimeType: "application/json",
            },
          },
        }),
      },
    });
    await t.db.budgetEnvelope.updateMany({
      where: scope,
      data: { spentMinor: { increment: 7 } },
    });
    const bill = await importHistoricalBooking(t, dispatchKey);
    const render = vi.spyOn(bindings.renderer, "render").mockResolvedValue({
      video: Buffer.from("fake-video"),
      cover: Buffer.from("fake-cover"),
      words: [{ text: "fixture", start: 0, end: 1 }],
      highlights: [],
      cues: [],
      duration: 30,
    });
    const originalDescriptors = await bindings.assembly.execute(t.context, run, t.brief);
    const original = await readManifest(setup, originalDescriptors);
    const text = { dispatchKey, providerJobId, costMinor: 7, postedNetMinor: 7 };
    expect(original.receipts.find((receipt) => receipt.dispatchKey === dispatchKey)).toMatchObject({
      ...text,
      costBasis: "RESERVATION",
    });

    await bill(7);
    const rebuiltDescriptors = await bindings.assembly.artifacts(t.context, run);
    const rebuilt = await readManifest(setup, rebuiltDescriptors);
    expect(rebuilt.receipts.find((receipt) => receipt.dispatchKey === dispatchKey)).toMatchObject({
      ...text,
      costBasis: "BILLED",
    });
    expect(rebuilt.totalCostMinor).toBe(original.totalCostMinor);
    expect(rebuilt.videoChecksumSha256).toBe(original.videoChecksumSha256);

    expect(await bindings.assembly.artifacts(t.context, run)).toEqual(rebuiltDescriptors);
    expect(
      await t.db.runEvent.findMany({
        where: {
          ...scope,
          stepId: attemptId,
          payload: { path: ["manifestReceiptChanged"], equals: true },
        },
        select: { payload: true },
      }),
    ).toMatchObject([{ payload: { netDelta: 0, manifestReceiptChanged: true } }]);
    expect(render).toHaveBeenCalledOnce();
  },
);
