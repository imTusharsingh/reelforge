import { randomUUID } from "node:crypto";
import { AssemblyManifestSchema, type MediaReceipt } from "@reelforge/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { json, type Artifact } from "../runs/runs.types.js";
import {
  attachHistoricalGoogleId,
  historicalTextFixture,
  importHistoricalBooking,
  readArtifact,
  readReceipt,
  repriceHistoricalShot,
  readManifest,
} from "./historical-text-receipt.fixture.js";
import { setupAssembly } from "./media-assembly.fixture.js";

const renderedFixture = {
  video: Buffer.from("fake-video"),
  cover: Buffer.from("fake-cover"),
  words: [{ text: "fixture", start: 0, end: 1 }],
  highlights: [],
  cues: [],
  duration: 30,
};

function promptReceipt(): Awaited<
  ReturnType<typeof setupAssembly>
>["plan"]["manifest"]["prompts"][number] {
  return {
    role: "scriptwriter",
    version: 2,
    templateVersionId: randomUUID(),
    promptSnapshotId: randomUUID(),
    configSnapshotId: randomUUID(),
    fingerprintSha256: "a".repeat(64),
  };
}

async function startAssemblyStage({
  t,
  run,
  bindings,
  plan,
}: Awaited<ReturnType<typeof setupAssembly>>): Promise<void> {
  vi.mocked(bindings.planning.saved).mockResolvedValue({
    ...plan,
    manifest: { ...plan.manifest, prompts: [promptReceipt()] },
  });
  await t.db.videoRunStep.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      key: "ASSEMBLING",
      attempt: 1,
      state: "RUNNING",
      idempotencyKey: `${run.id}:ASSEMBLING:1`,
      input: {},
    },
  });
}

async function seedHistoricalManifest(
  setup: Awaited<ReturnType<typeof setupAssembly>>,
  receipts: MediaReceipt[],
  extraPosted = 0,
): Promise<{ source: Artifact; media: Artifact; bytes: Buffer }> {
  const { t, run } = setup;
  const media = await t.artifacts.put(
    t.context,
    "final",
    Buffer.from("rendered-video"),
    "video/mp4",
  );
  const bytes = Buffer.from(
    JSON.stringify(
      AssemblyManifestSchema.parse({
        schemaVersion: "1.0",
        workspaceId: run.workspaceId,
        runId: run.id,
        briefId: t.brief.id,
        briefVersion: t.brief.version,
        durationSeconds: 30,
        width: 1080,
        height: 1920,
        fps: 24,
        videoCodec: "h264",
        narrationLanguage: "English",
        receipts,
        words: renderedFixture.words,
        promptVersions: [promptReceipt()],
        totalCostMinor: receipts.reduce((total, receipt) => total + receipt.costMinor, extraPosted),
        videoChecksumSha256: media.checksumSha256,
      }),
    ),
  );
  const source = await t.artifacts.put(t.context, "manifest", bytes, "application/json");
  await t.db.videoRunStep.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      key: "local:assembly",
      state: "SUCCEEDED",
      idempotencyKey: `${run.id}:local:assembly:1`,
      input: {},
      output: json({ storageArtifacts: [media, source] }),
    },
  });
  return { source, media, bytes };
}

describe.skipIf(!process.env.DATABASE_URL)("assembly receipt upgrade safety", () => {
  const fixture = runsFixture();
  beforeEach(() => {
    vi.stubEnv("GEMINI_TTS_MODEL", "fixture-TTS");
    vi.stubEnv("GEMINI_MUSIC_MODEL", "fixture-music");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("normalizes a successful pre-upgrade text receipt in a newly packaged manifest", async () => {
    const setup = await setupAssembly(fixture);
    const { t, run, bindings, plan } = setup;
    await startAssemblyStage(setup);
    const dispatchKey = `${run.id}:media:text:scriptwriter:1`;
    const key = "media:text:scriptwriter";
    const artifact = await t.artifacts.put(
      t.context,
      "refs",
      Buffer.from("{}"),
      "application/json",
    );
    const legacy = {
      key,
      providerId: "gemini",
      providerJobId: dispatchKey,
      modelId: "fixture-text",
      promptVersion: "fixture:v1",
      seconds: 0,
      costMinor: 7,
      objectKey: artifact.objectKey,
      checksumSha256: artifact.checksumSha256,
      mimeType: "application/json",
    };
    const row = await t.db.videoRunStep.create({
      data: {
        workspaceId: run.workspaceId,
        runId: run.id,
        key,
        attempt: 1,
        state: "SUCCEEDED",
        idempotencyKey: dispatchKey,
        providerJobId: dispatchKey,
        input: {},
        output: json({ result: { receipt: legacy, output: plan.script } }),
      },
    });
    vi.spyOn(bindings.renderer, "render").mockResolvedValue(renderedFixture);
    const artifacts = await bindings.assembly.execute(t.context, run, t.brief);
    const manifest = artifacts.find(({ kind }) => kind === "manifest")!;
    const data = AssemblyManifestSchema.parse(
      JSON.parse((await readArtifact(setup, manifest)).toString()),
    );
    expect(data.receipts.find((receipt) => receipt.key === key)).toMatchObject({
      providerJobId: null,
      dispatchKey,
    });
    expect(await t.db.videoRunStep.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      providerJobId: dispatchKey,
      output: { result: { receipt: legacy, output: plan.script } },
    });
  });

  it("publishes a receipt folded during render and adds only the shot delta on rebuild", async () => {
    const setup = await setupAssembly(fixture);
    const { t, run, bindings, plan } = setup;
    await startAssemblyStage(setup);
    const { dispatchKey } = await historicalTextFixture(setup, "id-less");
    const budget = (): Promise<{ spentMinor: number }> =>
      t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    await t.db.budgetEnvelope.updateMany({
      where: { runId: run.id },
      data: { spentMinor: { increment: 7 } },
    });
    let beforeTextBill = 0;
    vi.spyOn(bindings.renderer, "render").mockImplementationOnce(async () => {
      beforeTextBill = (await budget()).spentMinor;
      await attachHistoricalGoogleId(t, dispatchKey);
      return renderedFixture;
    });
    const published = await bindings.assembly.execute(t.context, run, t.brief);
    const first = await readManifest(setup, published);
    const text = {
      dispatchKey,
      costMinor: 20,
      costBasis: "BILLED",
      providerJobId: "historical-google-id",
    };
    expect(first.receipts.find((r) => r.dispatchKey === dispatchKey)).toMatchObject(text);
    expect(first.totalCostMinor).toBe(beforeTextBill + 13);
    const key = `shot-${plan.manifest.shots[0]!.ordinal}`;
    await repriceHistoricalShot(setup, key);
    const rebuilt = await readManifest(setup, await bindings.assembly.artifacts(t.context, run));
    expect(rebuilt.receipts.find((r) => r.dispatchKey === dispatchKey)).toMatchObject(text);
    expect(rebuilt.totalCostMinor).toBe(first.totalCostMinor + 11);
  });

  it("rebuilds a credited text line at its gross bill and adjusts the published total by its net posting", async () => {
    const setup = await setupAssembly(fixture);
    const { t, run, bindings, plan } = setup;
    await startAssemblyStage(setup);
    const { dispatchKey } = await historicalTextFixture(setup, "id-less");
    await t.db.budgetEnvelope.updateMany({
      where: { runId: run.id },
      data: { spentMinor: { increment: 7 } },
    });
    const bill = await importHistoricalBooking(t, dispatchKey);
    const step = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, idempotencyKey: dispatchKey },
    });
    vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
    await t.usage.createAdjustment(t.context, {
      kind: "CREDIT",
      textAttemptId: step.id,
      operationKey: "verified-refund",
      reason: "invoice refund",
      amountMinor: 5,
    });
    vi.spyOn(bindings.renderer, "render").mockResolvedValue(renderedFixture);
    const published = await readManifest(
      setup,
      await bindings.assembly.execute(t.context, run, t.brief),
    );
    expect(published.receipts.find((r) => r.dispatchKey === dispatchKey)).toMatchObject({
      costMinor: 7,
      postedNetMinor: 2,
    });
    await bill(2);
    await repriceHistoricalShot(setup, `shot-${plan.manifest.shots[0]!.ordinal}`);
    const rebuilt = await readManifest(setup, await bindings.assembly.artifacts(t.context, run));
    expect(rebuilt.receipts.find((r) => r.dispatchKey === dispatchKey)).toMatchObject({
      providerJobId: "historical-google-id",
      costBasis: "BILLED",
      costMinor: 2,
      postedNetMinor: 0,
    });
    expect(rebuilt.totalCostMinor).toBe(published.totalCostMinor + 11 - 2);
    expect(
      (await t.db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } })).spentMinor,
    ).toBe(rebuilt.totalCostMinor);
  });

  it.each([
    "id-less",
    "late ID",
    "ambiguous",
    "inconsistent total",
    "main total with refused shot",
  ] as const)(
    "reprices only the rendered shot while resolving historical text: %s",
    async (mode) => {
      const setup = await setupAssembly(fixture);
      const { t, run, bindings, plan } = setup;
      const unmatchedSpend = mode === "main total with refused shot" ? 9 : 0;
      const { receipt, dispatchKey } = await historicalTextFixture(
        setup,
        mode === "inconsistent total"
          ? "late ID"
          : mode === "main total with refused shot"
            ? "id-less"
            : mode,
      );
      if (unmatchedSpend) await importHistoricalBooking(t, dispatchKey);
      const key = `shot-${plan.manifest.shots[0]!.ordinal}`;
      const original = readReceipt(
        (await t.db.videoRunStep.findFirstOrThrow({ where: { runId: run.id, key } })).output,
      );
      const historical = await seedHistoricalManifest(
        setup,
        [receipt, original],
        mode === "inconsistent total" ? 13 : unmatchedSpend,
      );
      const corrected = await repriceHistoricalShot(setup, key);

      const descriptors = await bindings.assembly.artifacts(t.context, run);
      expect(await readArtifact(setup, historical.source)).toEqual(historical.bytes);
      expect(descriptors.find((item) => item.kind === "final")).toEqual(historical.media);
      if (mode === "ambiguous" || mode === "inconsistent total") {
        expect(descriptors).toEqual([historical.media]);
        expect(
          await t.db.videoRunStep.findFirstOrThrow({
            where: { runId: run.id, key: "local:assembly" },
          }),
        ).toMatchObject({ output: { pendingManifest: historical.source } });
        return;
      }
      const descriptor = descriptors.find((item) => item.kind === "manifest")!;
      expect(descriptor.objectKey).not.toBe(historical.source.objectKey);
      const rebuilt = AssemblyManifestSchema.parse(
        JSON.parse((await readArtifact(setup, descriptor)).toString()),
      );
      expect(rebuilt.receipts).toEqual([
        {
          ...receipt,
          dispatchKey,
          ...(mode === "late ID" && { costMinor: 20, postedNetMinor: 20, costBasis: "BILLED" }),
          ...(unmatchedSpend && { postedNetMinor: 7 }),
          providerJobId: mode === "late ID" ? "historical-google-id" : null,
        },
        corrected,
      ]);
      expect(rebuilt.videoChecksumSha256).toBe(historical.media.checksumSha256);
      expect(rebuilt.totalCostMinor).toBe(
        (mode === "late ID" ? 20 : receipt.costMinor) + corrected.costMinor + unmatchedSpend,
      );
    },
  );

  it("rejects the newest successful shot before audio until that exact reshoot has a valid remote receipt", async () => {
    const setup = await setupAssembly(fixture);
    const { t, run, bindings, native, plan } = setup;
    await startAssemblyStage(setup);
    const key = `shot-${plan.manifest.shots[0]!.ordinal}`;
    const first = await t.db.videoRunStep.findFirstOrThrow({ where: { runId: run.id, key } });
    const old = readReceipt(first.output);
    const clip = await t.artifacts.put(t.context, "clips", Buffer.from("reshoot"), "video/mp4");
    const dispatchKey = `${run.id}:${key}:2`;
    const receipt = {
      ...old,
      dispatchKey,
      providerJobId: null,
      objectKey: clip.objectKey,
      checksumSha256: clip.checksumSha256,
    };
    const reshoot = await t.db.videoRunStep.create({
      data: {
        workspaceId: run.workspaceId,
        runId: run.id,
        key,
        idempotencyKey: dispatchKey,
        attempt: 2,
        providerId: old.providerId,
        state: "SUCCEEDED",
        input: {},
        output: json({ receipt }),
      },
    });
    const narration = vi.spyOn(native.tts, "submit");
    const music = vi.spyOn(native.music, "submit");
    const render = vi.spyOn(bindings.renderer, "render").mockResolvedValue(renderedFixture);
    const assemble = (): ReturnType<typeof bindings.assembly.execute> =>
      bindings.assembly.execute(t.context, run, t.brief);
    const reject = async (): Promise<void> => {
      await expect(assemble()).rejects.toMatchObject({ code: "ASSEMBLY_SHOT_RECEIPT_MISSING" });
      expect(narration).not.toHaveBeenCalled();
      expect(music).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
      expect(
        await t.db.videoRunStep.count({ where: { runId: run.id, key: "local:assembly" } }),
      ).toBe(0);
    };
    await reject();
    const realId = "provider-reshoot";
    await t.db.videoRunStep.update({
      where: { id: reshoot.id },
      data: {
        providerJobId: realId,
        output: json({ receipt: { ...receipt, providerJobId: old.providerJobId } }),
      },
    });
    await reject();
    await t.db.videoRunStep.update({ where: { id: reshoot.id }, data: { output: {} } });
    await reject();
    const valid = { ...receipt, providerJobId: realId };
    for (const mismatched of [
      { objectKey: old.objectKey },
      { checksumSha256: old.checksumSha256 },
    ]) {
      await t.db.videoRunStep.update({
        where: { id: reshoot.id },
        data: { output: json({ storageArtifacts: [clip], receipt: { ...valid, ...mismatched } }) },
      });
      await reject();
    }
    await t.db.videoRunStep.update({
      where: { id: reshoot.id },
      data: { output: json({ storageArtifacts: [clip], receipt: valid }) },
    });
    const descriptors = await assemble();
    expect(narration).toHaveBeenCalledOnce();
    expect(music).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    expect(render.mock.calls[0]![0].clips[0]!.receipt).toEqual(valid);
    const manifest = AssemblyManifestSchema.parse(
      JSON.parse(
        (
          await readArtifact(
            setup,
            descriptors.find((artifact) => artifact.kind === "manifest")!,
          )
        ).toString(),
      ),
    );
    expect(manifest.receipts.filter((item) => item.key === key)).toEqual([valid]);
  });
});
