import { afterEach, expect, it, vi } from "vitest";
import { PLANNING_MANIFEST_KEY } from "../runs/run-outcomes.js";
import { runsFixture, generating } from "../runs/runs.fixture.js";
import { json } from "../runs/runs.types.js";
import { scriptFixture, shotsFixture, planningFixture } from "../script/planning.fixture.js";
import { bindMedia } from "./media-bindings.fixture.js";
import { fakeMediaPorts } from "./media-recovery.fixture.js";

const fixture = runsFixture();
const narrator = { providerId: "gemini", voiceId: "narrator", language: "English", pace: 1 };
afterEach(() => vi.unstubAllEnvs());

it.skipIf(!process.env.DATABASE_URL)(
  "collects admitted narration without buying new audio for an impossible saved plan",
  async () => {
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
    const plan = {
      script: scriptFixture(),
      manifest: {
        schemaVersion: "1.0" as const,
        workspaceId: run.workspaceId,
        runId: run.id,
        briefId: t.brief.id,
        briefVersion: 1,
        narratorVoice: narrator,
        prompts: [],
        shots: shotsFixture(planningFixture()).map((shot) => ({ ...shot, durationSeconds: 5 })),
      },
    };
    vi.spyOn(bindings.planning, "saved").mockResolvedValue(plan);
    const narrationSubmit = vi.spyOn(native.tts, "submit");
    const musicSubmit = vi.spyOn(native.music, "submit");
    const fetchNarration = vi.spyOn(native.tts, "fetch");
    const render = vi.spyOn(bindings.renderer, "render");
    vi.spyOn(native.tts, "poll").mockResolvedValueOnce("running");
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
    const line = (n: number): string => Array<string>(n).fill("planet").join(" ");
    plan.script = {
      hook: line(4),
      beats: [line(26), line(26), line(26)],
      payoff: line(4),
      cta: line(4),
      language: "English",
      wordCount: 90,
    };
    await db.videoRunStep.create({
      data: {
        workspaceId: run.workspaceId,
        runId: run.id,
        key: PLANNING_MANIFEST_KEY,
        idempotencyKey: `${run.id}:legacy-plan`,
        state: "SUCCEEDED",
        input: {},
        output: json(plan),
      },
    });
    await expect(bindings.assembly.execute(t.context, run, t.brief)).rejects.toMatchObject({
      response: { code: "SAVED_CAPTION_PLAN_UNUSABLE" },
    });
    expect(narrationSubmit).toHaveBeenCalledOnce();
    expect(fetchNarration).toHaveBeenCalledOnce();
    expect(musicSubmit).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(
      await t.db.usageReservation.findMany({
        where: { workspaceId: t.context.workspaceId },
        select: { status: true },
      }),
    ).toEqual([{ status: "COMMITTED" }]);
  },
);
