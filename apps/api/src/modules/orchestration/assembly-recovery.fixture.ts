import { expect, vi } from "vitest";
import { MediaReceiptSchema } from "@reelforge/contracts";
import { ModuleRef } from "@nestjs/core";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { MediaAssembly } from "../composition/media-assembly.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { SpawnProcessRunner } from "../composition/composition.engine.js";
import { CriticStep } from "../quality/critic.step.js";
import { RunsQueue } from "../runs/runs.queue.js";
import { RunsService } from "../runs/runs.service.js";
import type { Tenant } from "../runs/runs.fixture.js";
import { generating, generateClips } from "../runs/runs.fixture.js";
import { json, type Run } from "../runs/runs.types.js";
import { scriptFixture } from "../script/planning.fixture.js";
import { VideoRunEngine } from "./video-run.engine.js";

export async function bindAssembly(
  t: Tenant,
  state: "ASSEMBLING" | "CRITIC",
): Promise<{
  run: Run;
  native: ReturnType<typeof fakeMediaPorts>;
  media: ReturnType<typeof bindMedia>;
  restart: () => VideoRunEngine;
  job: ReturnType<RunsService["job"]>;
}> {
  vi.stubEnv("GEMINI_TTS_MODEL", "fixture-tts");
  vi.stubEnv("GEMINI_MUSIC_MODEL", "fixture-music");
  await generating(t);
  await generateClips(t);
  await seedPlayableReceipts(t);
  await t.engine.process(t.runs.job(t.context, t.run.id));
  const db = t.store.scoped(t.context);
  await db.videoRun.updateMany({ where: { id: t.run.id }, data: { state } });
  const roles = ["scriptwriter", "director", "art-director"] as const;
  await db.videoRunStep.createMany({
    data: roles.map((role) => ({
      workspaceId: t.run.workspaceId,
      runId: t.run.id,
      key: `media:text:${role}`,
      idempotencyKey: `${t.run.id}:legacy:${role}`,
      state: "SUCCEEDED",
      input: {},
      output: json({
        result: {
          output: role === "scriptwriter" ? scriptFixture() : {},
          promptVersion: {
            role,
            version: 2,
            templateVersionId: t.run.id,
            promptSnapshotId: t.run.id,
            configSnapshotId: t.run.id,
            fingerprintSha256: "a".repeat(64),
          },
        },
      }),
    })),
  });
  const run = await t.store.get(t.context, t.run.id);
  const native = fakeMediaPorts(
    t.context.workspaceId,
    t.storage,
    { clip: Buffer.from("clip"), image: Buffer.from("image"), audio: Buffer.from("audio") },
    [],
  );
  const media = bindMedia(t, native);
  if (state === "CRITIC") await criticWithCompletedEdit(t, run, media.assembly);
  const restart = (): VideoRunEngine =>
    new VideoRunEngine(t.runs, media.access.boundary, t.generation, t.planning, t.artifacts);
  return {
    native,
    media,
    restart,
    run,
    job: {
      ...t.runs.job(t.context, run.id),
      ...(state === "ASSEMBLING" ? { assembly: true as const } : {}),
    },
  };
}

async function seedPlayableReceipts(t: Tenant): Promise<void> {
  const db = t.store.scoped(t.context);
  const shots = await db.videoRunStep.findMany({
    where: { runId: t.run.id, key: { startsWith: "shot-" }, state: "SUCCEEDED" },
  });
  expect(shots.length).toBeGreaterThan(0);
  for (const shot of shots) {
    const artifact = await t.artifacts.put(t.context, "clips", Buffer.from(shot.key), "video/mp4");
    const receipt = MediaReceiptSchema.parse({
      key: shot.key,
      providerId: "gemini",
      providerJobId: shot.providerJobId,
      modelId: "fixture-video",
      promptVersion: "fixture:v1",
      seconds: 7.5,
      costMinor: shot.costMinor,
      objectKey: artifact.objectKey,
      checksumSha256: artifact.checksumSha256,
      mimeType: "video/mp4",
    });
    await db.videoRunStep.updateMany({
      where: { id: shot.id },
      data: { output: json({ receipt, storageArtifacts: [artifact] }) },
    });
  }
}

async function criticWithCompletedEdit(
  t: Tenant,
  run: Run,
  assembly: MediaAssembly,
): Promise<void> {
  await t.store.scoped(t.context).videoRunStep.create({
    data: {
      workspaceId: run.workspaceId,
      runId: run.id,
      key: "REEDIT",
      state: "SUCCEEDED",
      idempotencyKey: `${run.id}:review-fixture-edit`,
      input: {},
    },
  });
  const entries = new Map<unknown, unknown>([
    [RunsService, t.runs],
    [MediaAssembly, assembly],
  ]);
  t.planning.handlers = {
    ...t.planning.handlers,
    CRITIC: new CriticStep(
      { get: (token: unknown): unknown => entries.get(token) } as unknown as ModuleRef,
      () => {
        throw new Error("Unexpected critic dispatch after failed assembly");
      },
    ),
  };
}

export function failLocalCommand(transient: boolean): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(SpawnProcessRunner.prototype, "run")
    .mockImplementation(async ({ executable }) => {
      if (executable === "ffprobe")
        return {
          stdout: JSON.stringify({
            streams: [{ codec_type: "video", width: 720, height: 1280, duration: 30 }],
          }),
          stderr: "",
          exitCode: 0,
        };
      if (transient)
        throw Object.assign(new Error("Local worker is temporarily busy"), { code: "EBUSY" });
      return { stdout: "", stderr: "Unknown encoder 'libx264'", exitCode: 1 };
    });
}

export async function expectStopped(
  t: Tenant,
  run: Run,
  restart: () => VideoRunEngine,
  job: ReturnType<RunsService["job"]>,
  code: string,
  failures: number,
): Promise<void> {
  expect(await t.store.get(t.context, run.id)).toMatchObject({
    state: run.state,
    pauseReason: code,
  });
  expect(
    await t.store.scoped(t.context).videoRunStep.findFirst({
      where: { runId: run.id, key: run.state },
    }),
  ).toMatchObject({ state: "FAILED", error: { code, localRenderFailures: failures } });
  const enqueue = vi.fn();
  t.runs.queue = Object.assign(Object.create(RunsQueue.prototype), { enqueue });
  await restart().recover();
  expect(enqueue.mock.calls.filter(([entry]) => entry.runId === run.id)).toHaveLength(0);
  await expect(restart().process(job)).resolves.toBeNull();
  await expect(t.control.resume(t.context, run.id)).rejects.toThrow();
}
