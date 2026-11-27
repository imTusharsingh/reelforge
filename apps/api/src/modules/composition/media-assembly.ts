import {
  assertSavedCaptionFit,
  rejectInvalidSavedCaptionPlan,
} from "../usage-budget/run-caption-admission.js";
import { AUDIO_KEYS, acceptedAudio, failedAudio } from "../runs/run-audio.js";
import { currentPrices, shotReceipts } from "./assembly-receipts.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Injectable } from "@nestjs/common";
import {
  AssemblyManifestSchema,
  ShotSpecSchema,
  MediaReceiptSchema,
  planningTranscript,
  type ChannelBrief,
  type MediaReceipt,
} from "@reelforge/contracts";
import { json, type Context, type Run, type Step, type Artifact } from "../runs/runs.types.js";
import { MediaAccess } from "../scene-media/media-access.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import { MediaPorts } from "../scene-media/media-ports.js";
import { MediaPlanning } from "../scene-media/media-planning.js";
import { audioCosts } from "../scene-media/media-prices.js";
import { AssemblyInterrupted } from "../orchestration/video-run.handlers.js";
import { MediaRenderer } from "./media-render.js";
const audioRecoveryDuration = z.number().positive().max(120);
const admittedMusicInput = z.object({ spec: z.object({ durationSeconds: audioRecoveryDuration }) });
const pinnedDuration = z.object({
  brief: z.object({ targetDurationSeconds: audioRecoveryDuration }),
});

type AudioTrack = NonNullable<Awaited<ReturnType<MediaJobs["tick"]>>>;
type AssemblyAudio = { narration: AudioTrack; music: AudioTrack };

@Injectable()
export class MediaAssembly {
  public constructor(
    private readonly access: MediaAccess,
    private readonly jobs: MediaJobs,
    private readonly ports: MediaPorts,
    private readonly planning: MediaPlanning,
    private readonly renderer: MediaRenderer,
  ) {}
  public async execute(context: Context, run: Run, brief: ChannelBrief): Promise<Artifact[]> {
    const existing = await this.artifacts(context, run);
    if (existing.length) {
      if (!existing.some((a) => a.kind === "manifest"))
        throw new Error("Assembly manifest exceeds delivery budget");
      return existing;
    }
    const plan = await this.planning
      .saved(context, run, brief)
      .catch(rejectInvalidSavedCaptionPlan);
    if (!plan || !brief.narratorVoice) throw new Error("Pinned plan and channel voice required");
    const transcript = planningTranscript(plan.script);
    const seconds = plan.manifest.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
    assertSavedCaptionFit(transcript, brief.targetDurationSeconds, seconds);
    const { narration, music } = await this.audio(context, run, brief, transcript, seconds);
    const receipts = await this.receipts(context, run);
    const clips = plan.manifest.shots.map((shot) => {
      const receipt = receipts.findLast((item) => item.key === `shot-${shot.ordinal}`);
      if (!receipt || receipt.mimeType !== "video/mp4")
        throw new Error("Every shot requires a playable video receipt");
      return { receipt, seconds: shot.durationSeconds, transition: shot.transition };
    });
    const rendered = await this.renderer.render({
      workspaceId: context.workspaceId,
      clips,
      narration: narration.receipt,
      music: music.receipt,
      transcript,
      language: brief.languages.narration,
      pace: brief.narratorVoice.pace,
    });
    return this.persist(context, run, brief, plan, receipts, rendered);
  }
  private manifest(
    context: Context,
    run: Run,
    brief: ChannelBrief,
    plan: NonNullable<Awaited<ReturnType<MediaPlanning["saved"]>>>,
    totalCostMinor: number,
    receipts: MediaReceipt[],
    rendered: Awaited<ReturnType<MediaRenderer["render"]>>,
  ): ReturnType<typeof AssemblyManifestSchema.parse> {
    return AssemblyManifestSchema.parse({
      schemaVersion: "1.0",
      workspaceId: context.workspaceId,
      runId: run.id,
      briefId: brief.id,
      briefVersion: brief.version,
      durationSeconds: rendered.duration,
      width: 1080,
      height: 1920,
      fps: 24,
      videoCodec: "h264",
      narrationLanguage: brief.languages.narration,
      receipts,
      words: rendered.words,
      promptVersions: plan.manifest.prompts,
      totalCostMinor,
      videoChecksumSha256: createHash("sha256").update(rendered.video).digest("hex"),
    });
  }
  private async persist(
    context: Context,
    run: Run,
    brief: ChannelBrief,
    plan: NonNullable<Awaited<ReturnType<MediaPlanning["saved"]>>>,
    receipts: MediaReceipt[],
    rendered: Awaited<ReturnType<MediaRenderer["render"]>>,
  ): Promise<Artifact[]> {
    const artifacts = await this.storeRender(context, rendered);
    const saved = await this.access.runs.store.mutate<Artifact[] | null>(
      context,
      run.id,
      "assembly_created",
      async (db) => {
        const cached = await db.videoRunStep.findFirst({
          where: { runId: run.id, key: "local:assembly" },
        });
        if (cached) return { value: null, payload: { replay: true } };
        const prices = currentPrices(receipts, await shotReceipts(db, run.id));
        const budget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
        const manifest = this.manifest(
          context,
          run,
          brief,
          plan,
          budget.spentMinor,
          prices,
          rendered,
        );
        const descriptor = await this.access.artifacts.put(
          context,
          "manifest",
          Buffer.from(JSON.stringify(manifest)),
          "application/json",
        );
        const storageArtifacts = [...artifacts, descriptor];
        await db.videoRunStep.create({
          data: {
            workspaceId: context.workspaceId,
            runId: run.id,
            key: "local:assembly",
            idempotencyKey: `${run.id}:local:assembly:1`,
            attempt: 1,
            state: "SUCCEEDED",
            input: {},
            output: json({ storageArtifacts }),
            finishedAt: new Date(),
          },
        });
        return { value: storageArtifacts, payload: {} };
      },
    );
    return saved.value ?? this.artifacts(context, run);
  }
  private async storeRender(
    context: Context,
    rendered: Awaited<ReturnType<MediaRenderer["render"]>>,
  ): Promise<Artifact[]> {
    return Promise.all([
      this.access.artifacts.put(context, "final", rendered.video, "video/mp4"),
      this.access.artifacts.put(context, "refs", rendered.cover, "image/jpeg"),
      this.access.artifacts.put(
        context,
        "captions",
        Buffer.from(JSON.stringify(rendered.words)),
        "application/json",
      ),
    ]);
  }
  private async audio(
    context: Context,
    run: Run,
    brief: ChannelBrief,
    transcript: string,
    seconds: number,
  ): Promise<AssemblyAudio> {
    if (!brief.narratorVoice) throw new Error("Narrator required");
    const ports = await this.ports.get(context);
    const costs = audioCosts(seconds);
    await this.drainFailedAudio(context, run, ports, seconds);
    const [narration, music] = await Promise.allSettled([
      this.jobs.tick(
        context,
        run,
        "narration",
        ports.tts,
        { text: transcript, voice: brief.narratorVoice.voiceId },
        costs.narration,
        process.env.GEMINI_TTS_MODEL ?? "",
        "channel-narrator:v1",
        seconds,
      ),
      this.jobs.tick(
        context,
        run,
        "music",
        ports.music,
        {
          prompt:
            "Original unobtrusive background bed. Instrumental only; no lyrics, real people, brands or artist imitation.",
          instrumentalOnly: true,
          durationSeconds: seconds,
        },
        costs.music,
        process.env.GEMINI_MUSIC_MODEL ?? "",
        "instrumental-bed:v1",
        seconds,
      ),
    ]);
    if (narration.status === "rejected" || music.status === "rejected") {
      const failure = await failedAudio(this.access.runs.store.scoped(context), run.id);
      if (failure) return this.failAssembly(context, run, failure);
    }
    if (narration.status === "rejected") throw narration.reason;
    if (music.status === "rejected") throw music.reason;
    if (!narration.value || !music.value) throw new AssemblyInterrupted(12000);
    return { narration: narration.value, music: music.value };
  }
  private async drainFailedAudio(
    context: Context,
    run: Run,
    ports: Awaited<ReturnType<MediaPorts["get"]>>,
    seconds: number,
  ): Promise<void> {
    const failed = await failedAudio(this.access.runs.store.scoped(context), run.id);
    if (failed) {
      await this.drainAudio(context, run, ports, seconds);
      const db = this.access.runs.store.scoped(context);
      if (
        (await db.videoRunStep.findFirst({
          where: { runId: run.id, key: "ASSEMBLING", state: "FAILED" },
        })) &&
        (await acceptedAudio(db, this.access.runs.store.db, run)).length
      )
        throw new AssemblyInterrupted(12000);
      return this.failAssembly(context, run, failed);
    }
  }
  public async collectAdmittedAudio(context: Context, run: Run): Promise<number | null> {
    const db = this.access.runs.store.scoped(context);
    const accepted = await acceptedAudio(db, this.access.runs.store.db, run);
    if (!accepted.length) return null;
    const shots = await db.shotSpec.findMany({ where: { runId: run.id } });
    const parsed = z
      .array(ShotSpecSchema)
      .min(1)
      .safeParse(shots.map((row) => row.document));
    const music = accepted.find((step) => step.key === "media:music");
    // A malformed storyboard must not strand an already submitted audio job.
    const seconds = parsed.success
      ? parsed.data.reduce((total, shot) => total + shot.durationSeconds, 0)
      : (admittedMusicInput.safeParse(music?.input).data?.spec.durationSeconds ??
        pinnedDuration.safeParse(run.inputSnapshot).data?.brief.targetDurationSeconds ??
        45);
    await this.drainAudio(context, run, await this.ports.get(context), seconds, accepted);
    return (await acceptedAudio(db, this.access.runs.store.db, run)).length ? 12000 : null;
  }

  private async drainAudio(
    context: Context,
    run: Run,
    ports: Awaited<ReturnType<MediaPorts["get"]>>,
    seconds: number,
    accepted?: Step[],
  ): Promise<void> {
    const active =
      accepted ??
      (await this.access.runs.store.scoped(context).videoRunStep.findMany({
        where: {
          runId: run.id,
          key: { in: AUDIO_KEYS },
          state: { in: ["RUNNING", "WAITING_EXTERNAL"] },
        },
      }));
    for (const step of active) {
      if (step.key === "media:narration")
        await this.jobs.drainAudio(context, step, ports.tts, seconds);
      else await this.jobs.drainAudio(context, step, ports.music, seconds);
    }
  }
  private async failAssembly(context: Context, run: Run, failure: Step): Promise<never> {
    const result = await this.access.runs.store.mutate(
      context,
      run.id,
      "assembly_input_failed",
      async (db, locked) => {
        if (locked.state !== "ASSEMBLING") throw new AssemblyInterrupted(null);
        const code =
          failure.error &&
          typeof failure.error === "object" &&
          "code" in failure.error &&
          typeof failure.error.code === "string"
            ? failure.error.code
            : "PROVIDER_FAILED";
        const changed = await db.videoRunStep.updateMany({
          where: { runId: run.id, key: "ASSEMBLING", state: "RUNNING" },
          data: {
            state: "FAILED",
            finishedAt: new Date(),
            error: { code, inputStepId: failure.id },
          },
        });
        const active = await db.videoRunStep.findFirst({
          where: {
            runId: run.id,
            key: { in: AUDIO_KEYS },
            state: { in: ["RUNNING", "WAITING_EXTERNAL"] },
          },
        });
        if (!changed.count && active) throw new AssemblyInterrupted(12000);
        if (!active)
          await db.videoRun.updateMany({
            where: { id: run.id },
            data: {
              state: "FAILED",
              pauseReason: code,
              ...(locked.effectiveAutonomy === "L3" ? { effectiveAutonomy: "L2" } : {}),
            },
          });
        return {
          value: !!active,
          eventType: changed.count ? "assembly_input_failed" : "assembly_failed",
          payload: { code, inputStepId: failure.id, draining: !!active },
        };
      },
    );
    await this.access.runs.events?.publish(result.event);
    throw new AssemblyInterrupted(result.value ? 12000 : null);
  }
  public async artifacts(context: Context, run: Run): Promise<Artifact[]> {
    await this.access.artifacts.refreshManifests(context, run.id);
    const step = await this.access.runs.store.scoped(context).videoRunStep.findFirst({
      where: { runId: run.id, key: "local:assembly", state: "SUCCEEDED" },
    });
    return this.access.artifacts.descriptors(step?.output);
  }
  private async receipts(context: Context, run: Run): Promise<MediaReceipt[]> {
    const steps = await this.access.runs.store.scoped(context).videoRunStep.findMany({
      where: { runId: run.id, state: "SUCCEEDED" },
      orderBy: [{ createdAt: "asc" }, { attempt: "asc" }],
    });
    return steps.flatMap((step) => {
      const record = step.output as Record<string, unknown> | null;
      const result = record?.result as Record<string, unknown> | undefined;
      const receipt = MediaReceiptSchema.safeParse(record?.receipt ?? result?.receipt);
      return receipt.success ? [receipt.data] : [];
    });
  }
}
