import { afterEach, expect, it, vi } from "vitest";
import { maxDeliveryBytes } from "../asset/content-delivery.js";
import { createMediaRuntimeGate, mediaRuntimeGate } from "../composition/media-runtime.js";
import { mediaProbeEnv, readyProbeOutput } from "../composition/media-runtime.fixture.js";
import { runsFixture } from "../runs/runs.fixture.js";
import { bindAssembly, expectStopped, failLocalCommand } from "./assembly-recovery.fixture.js";
import { recordAssemblyFailure } from "./assembly-recovery.js";
import { LocalAssemblyFailure } from "../composition/local-assembly-failure.js";

const fixture = runsFixture();
const test = it.skipIf(!process.env.DATABASE_URL);
const narrator = { providerId: "gemini", voiceId: "narrator", language: "English", pace: 1 };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test.each([
  ["ASSEMBLING", false, [null], "MEDIA_CODEC_UNAVAILABLE"],
  ["CRITIC", false, [null], "MEDIA_CODEC_UNAVAILABLE"],
  ["ASSEMBLING", true, [5000, 15000, null], "LOCAL_RENDER_RETRIES_EXHAUSTED"],
] as const)(
  "classifies the real render boundary in %s (transient: %s), then stops recovery",
  async (stage, transient, delays, terminal) => {
    const t = await fixture.tenant("L2", 30, narrator);
    const { run, native, media, restart, job } = await bindAssembly(t, stage);
    failLocalCommand(transient);
    const render = vi.spyOn(media.renderer, "render");
    const tts = vi.spyOn(native.tts, "submit");
    const music = vi.spyOn(native.music, "submit");
    for (const delay of delays) await expect(restart().process(job)).resolves.toBe(delay);
    await expectStopped(t, run, restart, job, terminal, delays.length);
    expect(render).toHaveBeenCalledTimes(delays.length);
    expect(tts).toHaveBeenCalledOnce();
    expect(music).toHaveBeenCalledOnce();
  },
);

test("pauses on a newly missing encoder during audio preflight, then drains only the admitted narration", async () => {
  const t = await fixture.tenant("L2", 30, narrator);
  const { run, native, media, restart, job } = await bindAssembly(t, "ASSEMBLING");
  const narration = vi.spyOn(native.tts, "submit");
  const poll = vi
    .spyOn(native.tts, "poll")
    .mockResolvedValueOnce("running")
    .mockResolvedValueOnce("running");
  const music = vi.spyOn(native.music, "submit");
  const render = vi.spyOn(media.renderer, "render");
  await expect(
    media.jobs.tick(
      t.context,
      run,
      "narration",
      native.tts,
      { text: "Existing narration", voice: "narrator" },
      4,
      "fixture-tts",
      "channel-narrator:v1",
      30,
    ),
  ).resolves.toBeNull();

  let codecAvailable = true;
  const gate = createMediaRuntimeGate(async (binary, args) => {
    if (!codecAvailable && binary === mediaProbeEnv.FFMPEG_PATH && args.includes("libx264"))
      throw new Error("Encoder not found");
    return readyProbeOutput(binary, args);
  });
  await gate.activate(mediaProbeEnv);
  vi.spyOn(mediaRuntimeGate, "prepareLanguage").mockImplementation((language) =>
    gate.prepareLanguage(language, mediaProbeEnv),
  );
  codecAvailable = false;
  await expect(restart().process(job)).resolves.toBe(12000);
  expect(poll).toHaveBeenCalledTimes(2);
  await expect(restart().process(job)).resolves.toBeNull();
  await expectStopped(t, run, restart, job, "MEDIA_TOOL_UNAVAILABLE", 1);
  expect(narration).toHaveBeenCalledOnce();
  expect(music).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  expect(
    await t.store.scoped(t.context).videoRunStep.findFirst({
      where: { runId: run.id, key: "media:narration" },
    }),
  ).toMatchObject({ state: "SUCCEEDED" });
});

test("records a missing shot receipt before initiating any audio", async () => {
  const t = await fixture.tenant("L2", 30, narrator);
  const { run, media, native, restart, job } = await bindAssembly(t, "ASSEMBLING");
  const render = vi.spyOn(media.renderer, "render");
  const tts = vi.spyOn(native.tts, "submit");
  await t.store.scoped(t.context).videoRunStep.updateMany({
    where: { runId: run.id, key: "shot-0" },
    data: { output: {} },
  });
  await expect(restart().process(job)).resolves.toBeNull();
  await expectStopped(t, run, restart, job, "ASSEMBLY_SHOT_RECEIPT_MISSING", 1);
  expect(tts).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
});

test("does not render again after producing an MP4 over the delivery limit", async () => {
  const t = await fixture.tenant("L2", 30, narrator);
  const { run, media, restart, job } = await bindAssembly(t, "ASSEMBLING");
  const put = vi.spyOn(t.artifacts, "put");
  const render = vi.spyOn(media.renderer, "render").mockResolvedValue({
    video: Buffer.allocUnsafe(maxDeliveryBytes + 1),
    cover: Buffer.from("jpeg"),
    words: [],
    highlights: [],
    cues: [],
    duration: 30,
  });
  await expect(restart().process(job)).resolves.toBeNull();
  await expectStopped(t, run, restart, job, "ASSEMBLY_ARTIFACT_TOO_LARGE", 1);
  expect(render).toHaveBeenCalledOnce();
  expect(put.mock.calls.some(([, kind]) => kind === "final")).toBe(false);
});

test("does not let late completion erase a failed stage or advance the run", async () => {
  const t = await fixture.tenant("L2", 30, narrator);
  const { run, media, restart, job } = await bindAssembly(t, "ASSEMBLING");
  vi.spyOn(media.renderer, "render").mockResolvedValue({
    video: Buffer.from("video"),
    cover: Buffer.from("jpeg"),
    words: [{ text: "One", start: 0, end: 0.5 }],
    highlights: [],
    cues: [],
    duration: 30,
  });
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const original = t.outputs.assembly.bind(t.outputs);
  vi.spyOn(t.outputs, "assembly").mockImplementation(async (...args) => {
    entered.resolve();
    await proceed.promise;
    return original(...args);
  });
  const processing = restart().process(job);
  try {
    await Promise.race([
      entered.promise,
      processing.then(() => {
        throw new Error("Worker exited before stage completion");
      }),
    ]);
    const current = await t.store.get(t.context, run.id);
    await recordAssemblyFailure(
      t.runs,
      t.context,
      current,
      new LocalAssemblyFailure("LOCAL_RENDER_FAILED", "Recorded local failure"),
    );
  } finally {
    proceed.resolve();
  }
  await expect(processing).resolves.toBeNull();
  await expectStopped(t, run, restart, job, "LOCAL_RENDER_FAILED", 1);
  expect(
    await t.store.scoped(t.context).runEvent.count({
      where: {
        runId: run.id,
        type: "stage_completed",
        payload: { path: ["stage"], equals: "ASSEMBLING" },
      },
    }),
  ).toBe(0);
});

test("reopens a completed CRITIC step when a re-edit is pending instead of advancing past it", async () => {
  const t = await fixture.tenant("L2", 30, narrator);
  const { run, restart, job } = await bindAssembly(t, "CRITIC");
  const db = t.store.scoped(t.context);
  await db.videoRunStep.updateMany({
    where: { runId: run.id, key: "REEDIT" },
    data: { state: "PENDING" },
  });
  await db.videoRunStep.create({
    data: {
      runId: run.id,
      workspaceId: run.workspaceId,
      key: "CRITIC",
      idempotencyKey: `${run.id}:previous-critic`,
      state: "SUCCEEDED",
      input: {},
    },
  });
  failLocalCommand(false);
  await expect(restart().process(job)).resolves.toBeNull();
  await expectStopped(t, run, restart, job, "MEDIA_CODEC_UNAVAILABLE", 1);
  expect(
    await db.videoRunStep.findFirst({ where: { runId: run.id, key: "REEDIT" } }),
  ).toMatchObject({ state: "PENDING" });
});
