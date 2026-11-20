import { Injectable } from "@nestjs/common";
import { PlanningRequestSchema, type ChannelBrief } from "@reelforge/contracts";
import { z } from "zod";
import type { Context, Run, Step } from "../runs/runs.types.js";
import { MediaAccess } from "../scene-media/media-access.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import { MediaPorts } from "../scene-media/media-ports.js";
import { ReferenceLibraryService } from "../reference-library/reference-library.service.js";
import { screenPlanningContent } from "../script/planning-guardrails.js";
import { CriticPipeline } from "./critic.pipeline.js";
import { CriticEvidence } from "./critic-evidence.js";

type Evidence = Awaited<ReturnType<CriticEvidence["load"]>>;
type Budget = {
  hardCapMinor: number;
  baseEstimateMinor: number;
  reshootReserveMinor: number;
  spentMinor: number;
  reservedMinor: number;
};
type Review = Awaited<ReturnType<CriticPipeline["review"]>>;
@Injectable()
export class RunCritic {
  public constructor(
    private readonly access: MediaAccess,
    private readonly accounts: MediaAccounts,
    private readonly ports: MediaPorts,
    private readonly evidence: CriticEvidence,
    private readonly quality: CriticPipeline,
  ) {}
  public async execute(
    context: Context,
    run: Run,
    brief: ChannelBrief,
    step: Step,
    attempt = step.attempt,
  ): Promise<ReturnType<RunCritic["report"]> & { novelty: { title: string; angle: string } }> {
    if (context.workspaceId !== run.workspaceId || context.role === "VIEWER")
      throw new Error("Critic actor is not authorized for the run");
    if (
      brief.workspaceId !== context.workspaceId ||
      brief.channelId !== run.channelId ||
      brief.id !== run.channelBriefId ||
      brief.version !== run.channelBriefVersion
    )
      throw new Error("Critic brief does not match the pinned run");
    await this.access.boundary.check(context, run);
    const db = this.access.runs.store.scoped(context);
    const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
    if (!budget) throw new Error("Critic budget envelope is unavailable");
    const evidence = await this.evidence.load(context, run, brief);
    const request = PlanningRequestSchema.parse({
      runId: run.id,
      brief,
      idea: brief.topic,
      format: brief.formatKey,
    });
    screenPlanningContent(
      request,
      JSON.stringify({ script: evidence.plan.script, shots: evidence.plan.manifest.shots }),
    );
    await this.verifyRights(context, evidence);
    const history = await this.history(context, run);
    const redo: string[] = [];
    const reedit = { requested: false };
    const result = await this.review(
      context,
      run,
      brief,
      attempt,
      evidence,
      budget,
      history,
      redo,
      reedit,
    );
    const currentBudget = await db.budgetEnvelope.findFirstOrThrow({ where: { runId: run.id } });
    return {
      ...this.report(result, currentBudget, redo, reedit.requested),
      novelty: { title: evidence.plan.script.hook, angle: evidence.plan.script.payoff },
    };
  }
  private async verifyRights(context: Context, evidence: Evidence): Promise<void> {
    const refs = evidence.plan.manifest.shots.flatMap((shot) => shot.references);
    if (refs.length === 0) return;
    const resolved = await this.access.modules
      .get(ReferenceLibraryService, { strict: false })
      .resolve(context, refs);
    const assets = await this.access.runs.store.db.asset.findMany({
      where: {
        workspaceId: context.workspaceId,
        OR: [
          { id: { in: resolved.flatMap((ref) => (ref.assetId ? [ref.assetId] : [])) } },
          { rootAssetId: { in: resolved.flatMap((ref) => (ref.assetId ? [ref.assetId] : [])) } },
        ],
      },
      select: {
        id: true,
        rootAssetId: true,
        version: true,
        checksumSha256: true,
        status: true,
        ownership: true,
        licenseType: true,
        licenseTerms: true,
        rightsHolder: true,
        rightsAttestedAt: true,
      },
    });
    const verified =
      resolved.length === refs.length &&
      resolved.every((reference) => {
        const asset = assets.find(
          (item) =>
            (item.id === reference.assetId || item.rootAssetId === reference.assetId) &&
            item.version === reference.assetVersion,
        );
        return Boolean(
          asset &&
          asset.version === reference.assetVersion &&
          asset.checksumSha256 === reference.checksumSha256 &&
          asset.status === "PUBLISHED" &&
          asset.licenseType?.trim() &&
          ((asset.ownership === "SYSTEM_GENERATED" && asset.licenseType === "SYSTEM_GENERATED") ||
            asset.licenseTerms?.trim()) &&
          asset.rightsHolder?.trim() &&
          asset.rightsAttestedAt,
        );
      });
    if (!verified) throw new Error("Critic reference rights evidence is unavailable");
  }
  private async history(context: Context, run: Run): Promise<{ title: string; angle: string }[]> {
    const previous = await this.access.runs.store.scoped(context).videoRun.findMany({
      where: {
        channelId: run.channelId,
        id: { not: run.id },
        state: { in: ["SCHEDULED", "PUBLISHED", "LEARNING"] },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    if (!previous.length) return [];
    const reviews = await this.access.runs.store.scoped(context).videoRunStep.findMany({
      where: {
        runId: { in: previous.map((row) => row.id) },
        key: "quality:packaging",
        state: "SUCCEEDED",
      },
      select: { output: true },
    });
    const schema = z.object({
      result: z.object({ novelty: z.object({ title: z.string(), angle: z.string() }) }),
    });
    return reviews.flatMap((row) => {
      const parsed = schema.safeParse(row.output);
      return parsed.success ? [parsed.data.result.novelty] : [];
    });
  }
  private async review(
    context: Context,
    run: Run,
    brief: ChannelBrief,
    attempt: number,
    evidence: Evidence,
    budget: Budget,
    history: { title: string; angle: string }[],
    redo: string[],
    reedit: { requested: boolean },
  ): Promise<Review> {
    const remainingCents = Math.max(
      0,
      Math.min(budget.hardCapMinor, budget.baseEstimateMinor + budget.reshootReserveMinor) -
        budget.spentMinor -
        budget.reservedMinor,
    );
    return this.quality.reviewRun(
      {
        clips: evidence.clips,
        brief: {
          requiredTerms: [],
          bannedTerms: [...brief.guardrails.bannedTopics, ...brief.guardrails.topicsToAvoid],
        },
        critic: {
          prompt: `Review this final video against the channel brief, script and shot plan. Score each requested rubric axis from 0 to 10. Compare the timing of visible captions to the audible narration. Evidence: ${JSON.stringify({ brief, script: evidence.plan.script, shots: evidence.plan.manifest.shots })}`,
          media: [
            { type: "video", mime_type: "video/mp4", data: evidence.final.toString("base64") },
          ],
          correlationId: run.correlationId,
        },
        redo: {
          remainingCents,
          reshoot: async (id) => {
            redo.push(id);
          },
          reedit: async () => {
            reedit.requested = true;
          },
        },
        package: this.packageInput(brief, evidence),
        history,
        novelty: { title: evidence.plan.script.hook, angle: evidence.plan.script.payoff },
      },
      {
        access: this.access,
        accounts: this.accounts,
        ports: this.ports,
        context,
        run,
        attempt,
      },
    );
  }
  private packageInput(
    brief: ChannelBrief,
    evidence: Evidence,
  ): Parameters<CriticPipeline["review"]>[0]["package"] {
    return {
      title: evidence.plan.script.hook.replace(/[<>]/g, "").trim() || brief.topic,
      description: [
        evidence.plan.script.hook,
        ...evidence.plan.script.beats,
        evidence.plan.script.payoff,
        evidence.plan.script.cta,
      ].join(" "),
      tags: [brief.niche, brief.topic],
      coverFrameTimestampMs: 1000,
    };
  }
  private report(
    result: Review,
    budget: Budget,
    redo: string[],
    reedit: boolean,
  ): {
    criticPassed: boolean;
    report: {
      recommendation: "APPROVE" | "REJECT";
      summary: string;
      gates: Record<string, boolean>;
    };
    packaging: Review["packaging"];
    details: Review["details"];
    redo: { shots: string[]; reedit: boolean };
  } {
    const gates = {
      policy: result.details.rubric.policy >= 5 && result.details.rubric.briefFit >= 5,
      rights: true,
      technical:
        result.details.rubric.captionSync >= 5 &&
        result.details.hardGates.every((gate) => gate.passed),
      budget:
        budget.spentMinor + budget.reservedMinor <=
        Math.min(budget.hardCapMinor, budget.baseEstimateMinor + budget.reshootReserveMinor),
      permission: true,
      score: result.criticPassed,
    };
    const criticPassed = result.criticPassed && Object.values(gates).every(Boolean);
    return {
      criticPassed,
      report: {
        recommendation: criticPassed ? "APPROVE" : "REJECT",
        summary: `Critic score ${result.details.score}/10; novelty ${result.noveltyScore}/10`,
        gates,
      },
      packaging: result.packaging,
      details: result.details,
      redo: { shots: redo, reedit },
    };
  }
}
