import { PackagingSchema } from "../../../../packages/contracts/src/quality";
import { PublishingPackageSchema } from "../../../../packages/contracts/src/publishing-automation";
import {
  criticReport,
  SavedCaptionPlanDetailSchema,
  type RunDetailView,
  type RunSummary,
} from "../../../../packages/contracts/src/run-experience";
export function isPublishedRun(run: RunSummary): boolean {
  return (
    (run.state === "PUBLISHED" || run.state === "LEARNING") && run.pauseReason !== "PUBLISH_DRY_RUN"
  );
}

const reconciliationPrefix = "RECONCILE_REQUIRED";

export function needsAttention(run: RunSummary): boolean {
  if (run.pauseReason === "HUMAN_REJECTED" || run.pauseReason === "PUBLISH_DRY_RUN") return false;
  if (run.state === "CANCELED") return run.pauseReason?.startsWith(reconciliationPrefix) ?? false;
  if (["PUBLISHED", "LEARNING"].includes(run.state)) return false;
  return (
    run.pauseReason !== null ||
    ["AWAITING_APPROVAL", "CRITIC", "PAUSED_BUDGET", "NEEDS_HUMAN", "FAILED"].includes(run.state)
  );
}

export function pauseLabel(reason: string): string {
  if (reason.startsWith(reconciliationPrefix)) {
    const context = reason.slice(reconciliationPrefix.length).replace(/^:\s*/, "").trim();
    return context
      ? `Provider reconciliation required: ${context}`
      : "Provider reconciliation required.";
  }
  return (
    (
      {
        SAVED_CAPTION_PLAN_UNUSABLE:
          "The saved caption plan can’t be used. Open the run for details.",
        MEDIA_TOOL_UNAVAILABLE:
          "Local media tools are unavailable. Check FFmpeg and narration tools before starting a new Short.",
        MEDIA_CODEC_UNAVAILABLE:
          "FFmpeg is missing a required encoder, MP4 muxer, or subtitle filter.",
        RENDER_DURATION_UNSUPPORTED: "The saved storyboard is outside the supported video length.",
        ASSEMBLY_ARTIFACT_TOO_LARGE: "The video exceeds the 128 MiB delivery limit.",
        ASSEMBLY_SHOT_RECEIPT_MISSING: "A shot is missing its playable video receipt.",
        ASSEMBLY_INPUTS_MISSING: "The saved plan or narrator is missing.",
        LOCAL_RENDER_FAILED: "Local rendering failed. Check the input media and local tools.",
        LOCAL_RENDER_RETRIES_EXHAUSTED: "Local rendering stopped after two retries.",
        CAPTIONS_UNREADABLE: "The rendered captions aren’t readable. Try shorter narration.",
        NARRATION_PACE_UNSUPPORTED: "The saved narrator pace isn’t supported.",
        NARRATION_LANGUAGE_UNSUPPORTED: "The saved narration language isn’t supported.",
        BUDGET_CAP: "Budget cap reached. Review spend before resuming.",
        PROVIDER_REFUSED: "Provider refused this content. Review the prompt.",
        HUMAN_REJECTED: "You rejected this Short. Publishing is blocked.",
        EMERGENCY_STOP: "Emergency stop is active.",
      } as Record<string, string>
    )[reason] ?? reason
  );
}
export function runPauseLabel(detail: RunDetailView): string {
  const reason = detail.run.pauseReason;
  if (!reason || reason === "PUBLISH_DRY_RUN") return "";
  if (reason !== "SAVED_CAPTION_PLAN_UNUSABLE") return pauseLabel(reason);
  const failure = detail.steps.findLast(
    (step) => step.key === detail.run.state && step.state === "FAILED",
  );
  const error = failure?.error;
  if (error && typeof error === "object" && "code" in error && error.code === reason) {
    const parse = SavedCaptionPlanDetailSchema.safeParse("detail" in error ? error.detail : null);
    if (parse.data === "MALFORMED_PLAN") return "The saved plan is invalid. Start a new Short.";
    if (parse.data === "CAPTIONS_TOO_LONG")
      return "The captions won’t fit. Start a new Short with shorter narration.";
  }
  return "The saved caption plan can’t be used. Start a new Short.";
}

export function latestCritic(detail: RunDetailView): ReturnType<typeof criticReport> {
  const step = detail.steps
    .filter((s) => s.key === "CRITIC" && s.state === "SUCCEEDED")
    .sort((a, b) => b.attempt - a.attempt)[0];
  return criticReport(step?.output);
}
export function dollars(minor: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);
}

export function stateLabel(state: string): string {
  return state
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

export function finalMedia(detail: RunDetailView): { video?: string; poster?: string } {
  const assembly = detail.steps.find((step) => step.key === "local:assembly");
  const groups = [...detail.artifactUrls].reverse();
  const hasFinal = (group: (typeof groups)[number]): boolean =>
    group.artifacts.some((item) => item.kind === "final" && item.contentType === "video/mp4");
  const current =
    groups.find((group) => group.stepId === assembly?.id && hasFinal(group)) ??
    groups.find(
      (group) =>
        hasFinal(group) &&
        !detail.steps.some(
          (step) => step.id === group.stepId && step.key.startsWith("quality:assembly-history:"),
        ),
    );
  const video = current?.artifacts.find(
    (item) => item.kind === "final" && item.contentType === "video/mp4",
  );
  const poster = current?.artifacts.find((item) => item.contentType.startsWith("image/"));
  return { ...(video && { video: video.url }), ...(poster && { poster: poster.url }) };
}

export function runMetadata(
  detail: RunDetailView,
): { title: string; description: string; tags: string[] } | null {
  const steps = [...detail.steps].sort((a, b) => b.attempt - a.attempt);
  for (const key of ["PACKAGING", "quality:packaging"]) {
    const output = steps.find((step) => step.key === key && step.state === "SUCCEEDED")?.output;
    if (!output || typeof output !== "object" || !("result" in output)) continue;
    const result = output.result;
    const published = PublishingPackageSchema.safeParse(result);
    if (published.success) return published.data;
    if (result && typeof result === "object" && "packaging" in result) {
      const packaged = PackagingSchema.safeParse(result.packaging);
      if (packaged.success) return packaged.data;
    }
  }
  return null;
}
