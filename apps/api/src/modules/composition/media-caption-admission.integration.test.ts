import { RunsQueue } from "../runs/runs.queue.js";
import { afterEach, expect, it, vi } from "vitest";
import { VideoRunEngine } from "../orchestration/video-run.engine.js";
import { runsFixture, generating } from "../runs/runs.fixture.js";
import { json } from "../runs/runs.types.js";
import { bindMedia } from "./media-bindings.fixture.js";
import { fakeMediaPorts } from "./media-recovery.fixture.js";

const fixture = runsFixture();
const narrator = { providerId: "gemini", voiceId: "narrator", language: "English", pace: 1 };
afterEach(() => vi.unstubAllEnvs());

it.skipIf(!process.env.DATABASE_URL).each([false, true])(
  "rejects an impossible saved plan before audio or rendering (music already submitted: %s)",
  async (musicAdmitted) => {
    vi.stubEnv("GEMINI_TTS_MODEL", "fixture-TTS");
    vi.stubEnv("GEMINI_MUSIC_MODEL", "fixture-music");
    const t = await fixture.tenant("L2", 30, narrator);
    await generating(t);
    const db = t.store.scoped(t.context);
    await db.videoRun.updateMany({ where: { id: t.run.id }, data: { state: "ASSEMBLING" } });
    const run = await t.store.get(t.context, t.run.id);
    const native = fakeMediaPorts(
      t.context.workspaceId,
      t.storage,
      { audio: Buffer.from("audio"), clip: Buffer.from("clip"), image: Buffer.from("image") },
      [],
    );
    const bindings = bindMedia(t, native);
    const narrationSubmit = vi.spyOn(native.tts, "submit");
    const musicSubmit = vi.spyOn(native.music, "submit");
    const fetchNarration = vi.spyOn(native.tts, "fetch");
    const fetchMusic = vi.spyOn(native.music, "fetch");
    const narrationPoll = vi.spyOn(native.tts, "poll").mockResolvedValueOnce("running");
    const musicPoll = vi.spyOn(native.music, "poll").mockResolvedValueOnce("running");
    await expect(
      bindings.jobs.tick(
        t.context,
        run,
        "narration",
        native.tts,
        { text: "Existing job", voice: narrator.voiceId },
        4,
        "fixture-TTS",
        "channel-narrator:v1",
        30,
      ),
    ).resolves.toBeNull();
    if (musicAdmitted)
      await expect(
        bindings.jobs.tick(
          t.context,
          run,
          "music",
          native.music,
          { prompt: "Existing music" },
          4,
          "fixture-music",
          "instrumental-bed:v1",
          30,
        ),
      ).resolves.toBeNull();
    const line = (n: number): string => Array<string>(n).fill("planet").join(" ");
    const script = {
      hook: line(4),
      beats: [line(26), line(26), line(26)],
      payoff: line(4),
      cta: line(4),
      language: "English",
      wordCount: 90,
    };
    const roles = ["scriptwriter", "director", "art-director"] as const;
    await db.videoRunStep.createMany({
      data: roles.map((role) => ({
        workspaceId: run.workspaceId,
        runId: run.id,
        key: `media:text:${role}`,
        idempotencyKey: `${run.id}:legacy:${role}`,
        state: "SUCCEEDED",
        input: {},
        output: json({
          result: {
            output: role === "scriptwriter" ? script : {},
            promptVersion: {
              role,
              version: 2,
              templateVersionId: run.id,
              promptSnapshotId: run.id,
              configSnapshotId: run.id,
              fingerprintSha256: "a".repeat(64),
            },
          },
        }),
      })),
    });
    const accepted = await db.videoRunStep.findMany({
      where: {
        runId: run.id,
        key: { in: ["media:narration", "media:music"] },
        state: "WAITING_EXTERNAL",
      },
    });
    expect(accepted).toHaveLength(musicAdmitted ? 2 : 1);
    expect(accepted.every(({ providerJobId }) => providerJobId?.startsWith("fixture-media-"))).toBe(
      true,
    );
    const restarted = bindMedia(t, native);
    const render = vi.spyOn(restarted.renderer, "render");
    const engine = new VideoRunEngine(
      t.runs,
      restarted.access.boundary,
      t.generation,
      t.planning,
      t.artifacts,
    );
    const job = { ...t.runs.job(t.context, run.id), assembly: true };
    await expect(engine.process(job)).resolves.toBe(12000);
    expect(await t.store.get(t.context, run.id)).toMatchObject({
      state: "ASSEMBLING",
      pauseReason: "SAVED_CAPTION_PLAN_UNUSABLE",
    });
    expect(
      await db.videoRunStep.findFirst({
        where: { runId: run.id, key: "ASSEMBLING" },
      }),
    ).toMatchObject({ state: "FAILED", error: { code: "SAVED_CAPTION_PLAN_UNUSABLE" } });
    expect(narrationPoll).toHaveBeenCalledOnce();
    expect(musicPoll).toHaveBeenCalledTimes(musicAdmitted ? 1 : 0);
    expect(
      await db.runEvent.findFirst({
        where: { runId: run.id, type: "assembly_input_failed" },
      }),
    ).toMatchObject({
      payload: {
        code: "SAVED_CAPTION_PLAN_UNUSABLE",
        message: "Saved captions cannot fit. Start a new Short with shorter narration.",
      },
    });
    const enqueue = vi.fn();
    t.runs.queue = Object.assign(Object.create(RunsQueue.prototype), { enqueue });
    await engine.recover();
    expect(
      enqueue.mock.calls
        .filter(([payload]) => payload.runId === run.id)
        .map(([payload]) => payload.assembly),
    ).toEqual([true]);
    await expect(engine.process(job)).resolves.toBeNull();
    enqueue.mockClear();
    await engine.recover();
    expect(enqueue.mock.calls.filter(([payload]) => payload.runId === run.id)).toHaveLength(0);
    await expect(t.control.resume(t.context, run.id)).rejects.toThrow("Saved captions cannot fit");
    expect(narrationSubmit).toHaveBeenCalledOnce();
    expect(fetchNarration).toHaveBeenCalledOnce();
    expect(musicSubmit).toHaveBeenCalledTimes(musicAdmitted ? 1 : 0);
    expect(fetchMusic).toHaveBeenCalledTimes(musicAdmitted ? 1 : 0);
    expect(render).not.toHaveBeenCalled();
    expect(
      await t.db.usageReservation.findMany({
        where: { workspaceId: t.context.workspaceId },
        select: { status: true },
      }),
    ).toEqual(Array.from({ length: musicAdmitted ? 2 : 1 }, () => ({ status: "COMMITTED" })));
  },
);
