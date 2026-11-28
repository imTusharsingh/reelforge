import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { readManifest, repriceHistoricalShot } from "./historical-text-receipt.fixture.js";
import { setupAssembly } from "./media-assembly.fixture.js";

const fixture = runsFixture();
afterEach(() => vi.unstubAllEnvs());

it.skipIf(!process.env.DATABASE_URL)(
  "publishes a slow archive correction after all run-detail callers time out",
  async () => {
    vi.stubEnv("GEMINI_TTS_MODEL", "fixture-TTS");
    vi.stubEnv("GEMINI_MUSIC_MODEL", "fixture-music");
    const setup = await setupAssembly(fixture);
    const { t, run, plan, bindings } = setup;
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
    const render = vi.spyOn(bindings.renderer, "render").mockResolvedValue({
      video: Buffer.from("rendered-video"),
      cover: Buffer.from("cover"),
      words: [{ text: "fixture", start: 0, end: 1 }],
      highlights: [],
      cues: [],
      duration: 30,
    });
    const originalDescriptors = await bindings.assembly.execute(t.context, run, t.brief);
    const original = await readManifest(setup, originalDescriptors);
    const source = originalDescriptors.find((artifact) => artifact.kind === "manifest")!;
    const shot = await repriceHistoricalShot(setup, `shot-${plan.manifest.shots[0]!.ordinal}`);
    const beforeRelease = {
      pendingManifest: { objectKey: source.objectKey },
      storageArtifacts: originalDescriptors.filter((artifact) => artifact.kind !== "manifest"),
    };

    const readStarted = Promise.withResolvers<void>();
    const readReleased = Promise.withResolvers<void>();
    const writeStarted = Promise.withResolvers<void>();
    const writeReleased = Promise.withResolvers<void>();
    const get = t.storage.getObject.bind(t.storage);
    const put = t.storage.putObject.bind(t.storage);
    const read = vi.spyOn(t.storage, "getObject").mockImplementation(async (input) => {
      if (input.objectKey === source.objectKey) {
        readStarted.resolve();
        await readReleased.promise;
      }
      return get(input);
    });
    const write = vi.spyOn(t.storage, "putObject").mockImplementation(async (input) => {
      writeStarted.resolve();
      await writeReleased.promise;
      return put(input);
    });

    // Fire only the request deadlines, without advancing Prisma or Vitest's own timers.
    const schedule = globalThis.setTimeout;
    const deadlines: (() => void)[] = [];
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 10_000 && callback.name === "archiveRequestDeadline")
          deadlines.push(() => callback(...args));
        return schedule(callback, delay, ...args);
      });
    const output = async (): Promise<unknown> =>
      (
        await t.db.videoRunStep.findFirstOrThrow({
          where: { runId: run.id, workspaceId: run.workspaceId, key: "local:assembly" },
        })
      ).output;
    const finalize = vi.spyOn(t.store, "mutate");
    const callers = [t.runs.detail(t.context, run.id)];
    try {
      await Promise.race([readStarted.promise, callers[0]]);
      callers.push(t.runs.detail(t.context, run.id), t.runs.detail(t.context, run.id));
      await expect.poll(() => deadlines.length).toBe(3);
      deadlines.forEach((fire) => fire());
      await Promise.all(callers);
      const before = await t.store.get(t.context, run.id);
      expect(await output()).toMatchObject(beforeRelease);
      expect(read).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();

      readReleased.resolve();
      await writeStarted.promise;
      expect(await output()).toMatchObject(beforeRelease);
      writeReleased.resolve();

      // Observing the database does not start another reconciliation.
      await expect
        .poll(async () =>
          t.db.runEvent.count({
            where: {
              runId: run.id,
              workspaceId: run.workspaceId,
              type: "assembly_receipts_checked",
            },
          }),
        )
        .toBe(1);
      expect(
        finalize.mock.calls.filter(([, , event]) => event === "assembly_receipts_snapshot"),
      ).toHaveLength(1);
      expect((await t.store.get(t.context, run.id)).revision).toBe(before.revision + 1);
      expect(read).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      const published = t.artifacts.descriptors(await output());
      const rebuilt = await readManifest(setup, published);
      expect(rebuilt.receipts.find((receipt) => receipt.key === shot.key)).toEqual(shot);
      expect(rebuilt.totalCostMinor).toBe(original.totalCostMinor + 11);
      expect(rebuilt.videoChecksumSha256).toBe(original.videoChecksumSha256);
      expect(render).toHaveBeenCalledOnce();
    } finally {
      readReleased.resolve();
      writeReleased.resolve();
      timer.mockRestore();
      read.mockRestore();
      write.mockRestore();
      await Promise.allSettled(callers);
      finalize.mockRestore();
    }
  },
);
