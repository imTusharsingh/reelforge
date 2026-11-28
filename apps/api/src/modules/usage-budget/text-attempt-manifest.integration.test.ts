import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  importHistoricalBooking,
  readManifest,
} from "../composition/historical-text-receipt.fixture.js";
import { setupAssembly } from "../composition/media-assembly.fixture.js";
import { InvalidCompletedScript, scriptwriterKey } from "../script/script-repair.js";
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

it.skipIf(!process.env.DATABASE_URL)(
  "a credit to the failed writer rebuilds the total once and preserves the repair receipt",
  async () => {
    const setup = await setupAssembly(fixture);
    const { t, run, bindings, plan } = setup;
    vi.stubEnv("GEMINI_TTS_MODEL", "fixture-TTS");
    vi.stubEnv("GEMINI_MUSIC_MODEL", "fixture-music");
    const writing = await t.db.videoRun.update({
      where: { id: run.id },
      data: { state: "SCRIPTING" },
    });
    const { accounts } = bindings;
    const original = await accounts.begin(
      t.context,
      writing,
      scriptwriterKey,
      {},
      7,
      "fixture-text",
      true,
    );
    await expect(
      accounts.dispatchTextAttempt(t.context, original, async (sent) => {
        await sent();
        throw new InvalidCompletedScript(
          { usage: {}, providerJobId: null },
          original.idempotencyKey,
          "Incorrect script word count",
        );
      }),
    ).rejects.toThrow("Incorrect script word count");
    const replacement = await accounts.begin(
      t.context,
      writing,
      scriptwriterKey,
      { repairOf: original.id },
      7,
      "fixture-text",
      true,
    );
    const completion = await accounts.dispatchTextAttempt(t.context, replacement, async (sent) => {
      await sent();
      return {
        dispatchKey: replacement.idempotencyKey,
        output: plan.script,
        usage: {},
        providerJobId: null,
      };
    });
    const artifact = await t.artifacts.put(
      t.context,
      "refs",
      Buffer.from(JSON.stringify(plan.script)),
      "application/json",
    );
    const receipt = {
      key: scriptwriterKey,
      dispatchKey: replacement.idempotencyKey,
      providerId: "gemini",
      providerJobId: null,
      modelId: "fixture-text",
      promptVersion: "scriptwriter:v3",
      seconds: 0,
      costMinor: 7,
      costBasis: "RESERVATION",
      objectKey: artifact.objectKey,
      checksumSha256: artifact.checksumSha256,
      mimeType: "application/json",
    };
    await accounts.complete(t.context, replacement, { ...completion, receipt, artifact });
    await t.db.videoRun.update({ where: { id: run.id }, data: { state: "ASSEMBLING" } });
    await t.db.videoRunStep.create({
      data: {
        workspaceId: run.workspaceId,
        runId: run.id,
        key: "ASSEMBLING",
        state: "RUNNING",
        idempotencyKey: `${run.id}:ASSEMBLING:1`,
        input: {},
      },
    });
    const prompt = {
      role: "scriptwriter" as const,
      version: 3 as const,
      templateVersionId: randomUUID(),
      promptSnapshotId: randomUUID(),
      configSnapshotId: randomUUID(),
      fingerprintSha256: "a".repeat(64),
    };
    vi.mocked(bindings.planning.saved).mockResolvedValue({
      ...plan,
      manifest: { ...plan.manifest, prompts: [prompt] },
    });
    const render = vi.spyOn(bindings.renderer, "render").mockResolvedValue({
      video: Buffer.from("video"),
      cover: Buffer.from("cover"),
      words: [{ text: "fixture", start: 0, end: 1 }],
      highlights: [],
      cues: [],
      duration: 30,
    });
    const first = await readManifest(
      setup,
      await bindings.assembly.execute(t.context, run, t.brief),
    );
    expect(first.receipts.filter((line) => line.key === scriptwriterKey)).toMatchObject([
      { dispatchKey: replacement.idempotencyKey, postedNetMinor: 7 },
    ]);
    await t.usage.createAdjustment(t.context, {
      kind: "CREDIT",
      textAttemptId: original.id,
      operationKey: "invalid-writer-credit",
      reason: "invoice refund",
      amountMinor: 5,
    });
    const descriptors = await bindings.assembly.artifacts(t.context, run);
    const updated = await readManifest(setup, descriptors);
    expect(updated.totalCostMinor).toBe(first.totalCostMinor - 5);
    expect(await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).toMatchObject({
      spentMinor: updated.totalCostMinor,
    });
    expect(updated.receipts).toEqual(first.receipts);
    expect(updated.videoChecksumSha256).toBe(first.videoChecksumSha256);
    expect(await bindings.assembly.artifacts(t.context, run)).toEqual(descriptors);
    expect(render).toHaveBeenCalledOnce();
  },
);
