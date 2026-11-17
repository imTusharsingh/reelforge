import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  AssemblyManifestSchema,
  MediaReceiptSchema,
  type ChannelBrief,
  type MediaReceipt,
} from "@reelforge/contracts";
import { reservationCents } from "@reelforge/ai-providers";
import { json, type Context, type Run, type Artifact } from "../runs/runs.types.js";
import { MediaAccess } from "../scene-media/media-access.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import { MediaPorts } from "../scene-media/media-ports.js";
import { MediaPlanning } from "../scene-media/media-planning.js";
import { MEDIA_OVERHEAD } from "../scene-media/media-prices.js";
import { MediaRenderer } from "./media-render.js";
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
    this.access.gate();
    const existing = await this.artifacts(context, run);
    if (existing.length) return existing;
    const plan = await this.planning.saved(context, run, brief);
    if (!plan || !brief.narratorVoice) throw new Error("Pinned plan and channel voice required");
    const { transcript, narration, music } = await this.audio(context, run, brief, plan);
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
    receipts: MediaReceipt[],
    rendered: Awaited<ReturnType<MediaRenderer["render"]>>,
  ): ReturnType<typeof AssemblyManifestSchema.parse> {
    const totalCostMinor = receipts.reduce((sum, receipt) => sum + receipt.costMinor, 0);
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
    const manifest = this.manifest(context, run, brief, plan, receipts, rendered);
    const artifacts = await Promise.all([
      this.access.artifacts.put(context, "final", rendered.video, "video/mp4"),
      this.access.artifacts.put(context, "refs", rendered.cover, "image/jpeg"),
      this.access.artifacts.put(
        context,
        "captions",
        Buffer.from(JSON.stringify(rendered.words)),
        "application/json",
      ),
      this.access.artifacts.put(
        context,
        "manifest",
        Buffer.from(JSON.stringify(manifest)),
        "application/json",
      ),
    ]);
    await this.access.runs.store.scoped(context).videoRunStep.create({
      data: {
        workspaceId: context.workspaceId,
        runId: run.id,
        key: "local:assembly",
        idempotencyKey: `${run.id}:local:assembly:1`,
        attempt: 1,
        state: "SUCCEEDED",
        input: {},
        output: json({ storageArtifacts: artifacts }),
        finishedAt: new Date(),
      },
    });
    return artifacts;
  }
  private async audio(
    context: Context,
    run: Run,
    brief: ChannelBrief,
    plan: NonNullable<Awaited<ReturnType<MediaPlanning["saved"]>>>,
  ): Promise<{
    transcript: string;
    narration: Awaited<ReturnType<MediaJobs["wait"]>>;
    music: Awaited<ReturnType<MediaJobs["wait"]>>;
  }> {
    if (!brief.narratorVoice) throw new Error("Narrator required");
    const transcript = [
      plan.script.hook,
      ...plan.script.beats,
      plan.script.payoff,
      plan.script.cta,
    ].join(" ");
    const ports = await this.ports.get(context),
      seconds = plan.manifest.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
    const [narration, music] = await Promise.all([
      this.jobs.wait(
        context,
        run,
        "narration",
        ports.tts,
        { text: transcript, voice: brief.narratorVoice.voiceId },
        reservationCents({
          currency: "USD",
          microUsd: Math.ceil((seconds / 10) * MEDIA_OVERHEAD.ttsPerTenSecondsMicroUsd),
        }),
        process.env.GEMINI_TTS_MODEL ?? "",
        "channel-narrator:v1",
        seconds,
      ),
      this.jobs.wait(
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
        reservationCents({ currency: "USD", microUsd: MEDIA_OVERHEAD.musicMicroUsd }),
        process.env.GEMINI_MUSIC_MODEL ?? "",
        "instrumental-bed:v1",
        seconds,
      ),
    ]);
    return { transcript, narration, music };
  }
  public async artifacts(context: Context, run: Run): Promise<Artifact[]> {
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
