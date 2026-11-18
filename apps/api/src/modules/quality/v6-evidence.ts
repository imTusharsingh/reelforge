import { Injectable } from "@nestjs/common";
import { AlignedWordSchema, AssemblyManifestSchema, type ChannelBrief } from "@reelforge/contracts";
import { z } from "zod";
import type { Context, Run } from "../runs/runs.types.js";
import { MediaAssembly } from "../composition/media-assembly.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import { MediaPlanning } from "../scene-media/media-planning.js";
import { V6MediaProbe } from "./v6-media-probe.js";
import { captionDriftMs } from "./v6-caption-drift.js";
import type { CriticClip } from "./v6-critic.js";

type Plan = NonNullable<Awaited<ReturnType<MediaPlanning["saved"]>>>;
type Manifest = z.infer<typeof AssemblyManifestSchema>;
@Injectable()
export class V6Evidence {
  public constructor(
    private readonly assembly: MediaAssembly,
    private readonly jobs: MediaJobs,
    private readonly planning: MediaPlanning,
    private readonly probe: V6MediaProbe,
  ) {}
  public async load(
    context: Context,
    run: Run,
    brief: ChannelBrief,
  ): Promise<{
    clips: CriticClip[];
    final: Buffer;
    plan: Plan;
  }> {
    const artifacts = await this.assembly.artifacts(context, run);
    const final = artifacts.find(
      (item) => item.kind === "final" && item.contentType === "video/mp4",
    );
    const manifestArtifact = artifacts.find((item) => item.kind === "manifest");
    const alignment = artifacts.find(
      (item) => item.kind === "captions" && item.contentType === "application/json",
    );
    const captions = artifacts.find(
      (item) => item.kind === "captions" && item.contentType === "text/plain",
    );
    const plan = await this.planning.saved(context, run, brief);
    if (!final || !manifestArtifact || !alignment || !captions || !plan)
      throw new Error("V5 assembly evidence is incomplete");
    const [finalBytes, manifestBytes, wordsBytes, captionsBytes] = await Promise.all([
      this.jobs.bytes(context, final),
      this.jobs.bytes(context, manifestArtifact),
      this.jobs.bytes(context, alignment),
      this.jobs.bytes(context, captions),
    ]);
    const manifest = AssemblyManifestSchema.parse(
      JSON.parse(manifestBytes.toString("utf8")) as unknown,
    );
    if (
      manifest.workspaceId !== context.workspaceId ||
      manifest.runId !== run.id ||
      manifest.briefId !== brief.id ||
      manifest.briefVersion !== brief.version ||
      manifest.videoChecksumSha256 !== final.checksumSha256
    )
      throw new Error("Assembly manifest provenance mismatch");
    const words = z
      .array(AlignedWordSchema)
      .min(1)
      .parse(JSON.parse(wordsBytes.toString("utf8")) as unknown);
    if (JSON.stringify(words) !== JSON.stringify(manifest.words))
      throw new Error("Alignment manifest mismatch");
    const drift = captionDriftMs(words, captionsBytes.toString("utf8"));
    return { clips: await this.clips(context, manifest, plan, drift), final: finalBytes, plan };
  }
  private async clips(
    context: Context,
    manifest: Manifest,
    plan: Plan,
    drift: number,
  ): Promise<CriticClip[]> {
    return Promise.all(
      plan.manifest.shots.map(async (shot) => {
        const receipt = manifest.receipts.findLast((item) => item.key === `shot-${shot.ordinal}`);
        if (!receipt || receipt.mimeType !== "video/mp4") throw new Error("Shot receipt missing");
        const bytes = await this.jobs.bytes(context, receipt);
        return {
          id: String(shot.ordinal),
          probe: await this.probe.inspect(bytes, drift),
          hookText: plan.script.hook,
          narrativeText: shot.voLine,
          visualDescription: `${shot.keyframePrompt} ${shot.motionPrompt}`,
          captionText: shot.onScreenText,
        };
      }),
    );
  }
}
