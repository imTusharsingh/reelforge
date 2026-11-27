import { randomUUID } from "node:crypto";
import { AssemblyManifestSchema } from "@reelforge/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { json } from "../runs/runs.types.js";
import { setupAssembly } from "./media-assembly.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("assembly receipt upgrade safety", () => {
  const fixture = runsFixture();
  beforeEach(() => {
    vi.stubEnv("GEMINI_TTS_MODEL", "fixture-TTS");
    vi.stubEnv("GEMINI_MUSIC_MODEL", "fixture-music");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("normalizes a successful pre-upgrade text receipt in a newly packaged manifest", async () => {
    const { t, run, bindings, plan } = await setupAssembly(fixture);
    vi.mocked(bindings.planning.saved).mockResolvedValue({
      ...plan,
      manifest: {
        ...plan.manifest,
        prompts: [
          {
            role: "scriptwriter",
            version: 2,
            templateVersionId: randomUUID(),
            promptSnapshotId: randomUUID(),
            configSnapshotId: randomUUID(),
            fingerprintSha256: "a".repeat(64),
          },
        ],
      },
    });
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
    vi.spyOn(bindings.renderer, "render").mockResolvedValue({
      video: Buffer.from("fake-video"),
      cover: Buffer.from("fake-cover"),
      words: [{ text: "fixture", start: 0, end: 1 }],
      highlights: [],
      cues: [],
      duration: 30,
    });
    const artifacts = await bindings.assembly.execute(t.context, run, t.brief);
    const manifest = artifacts.find(({ kind }) => kind === "manifest")!;
    const data = AssemblyManifestSchema.parse(
      JSON.parse(
        (
          await t.storage.getObject({
            workspaceId: run.workspaceId,
            objectKey: manifest.objectKey,
          })
        ).toString(),
      ),
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

  it("rejects a local-only video receipt before starting any paid audio", async () => {
    const { t, run, bindings, native, plan } = await setupAssembly(fixture);
    const key = `shot-${plan.manifest.shots[0]!.ordinal}`;
    const row = await t.db.videoRunStep.findFirstOrThrow({ where: { runId: run.id, key } });
    const output = row.output as { receipt: Record<string, unknown> };
    await t.db.videoRunStep.update({
      where: { id: row.id },
      data: {
        output: json({
          ...output,
          receipt: { ...output.receipt, providerJobId: null, dispatchKey: row.idempotencyKey },
        }),
      },
    });
    const narration = vi.spyOn(native.tts, "submit");
    const music = vi.spyOn(native.music, "submit");
    await expect(bindings.assembly.execute(t.context, run, t.brief)).rejects.toMatchObject({
      code: "ASSEMBLY_SHOT_RECEIPT_MISSING",
    });
    expect(narration).not.toHaveBeenCalled();
    expect(music).not.toHaveBeenCalled();
  });
});
