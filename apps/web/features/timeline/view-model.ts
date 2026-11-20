import { PackagingSchema } from "../../../../packages/contracts/src/quality";
import { PublishingPackageSchema } from "../../../../packages/contracts/src/publishing-automation";
import {
  criticReport,
  type RunDetailView,
} from "../../../../packages/contracts/src/run-experience";
export function pauseLabel(reason: string): string {
  return (
    (
      {
        BUDGET_CAP: "Budget cap reached. Review spend before resuming.",
        PROVIDER_REFUSED: "Provider refused this content. Review the prompt.",
        RECONCILE_REQUIRED: "Provider outcome is unknown. Reconcile before retrying.",
        HUMAN_REJECTED: "You rejected this Short. Publishing is blocked.",
        EMERGENCY_STOP: "Emergency stop is active.",
      } as Record<string, string>
    )[reason] ?? reason
  );
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
  return state.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function finalMedia(detail: RunDetailView): { video?: string; poster?: string } {
  const assembly = detail.steps.find((step) => step.key === "local:assembly");
  const groups = [...detail.artifactUrls].reverse();
  const hasFinal = (group: (typeof groups)[number]): boolean =>
    group.artifacts.some((item) => item.kind === "final" && item.contentType === "video/mp4");
  const current = groups.find((group) => group.stepId === assembly?.id && hasFinal(group))
    ?? groups.find((group) => hasFinal(group) && !detail.steps.some((step) => step.id === group.stepId && step.key.startsWith("quality:assembly-history:")));
  const video = current?.artifacts.find((item) => item.kind === "final" && item.contentType === "video/mp4");
  const poster = current?.artifacts.find((item) => item.contentType.startsWith("image/"));
  return { ...(video && { video: video.url }), ...(poster && { poster: poster.url }) };
}

export function runMetadata(detail: RunDetailView): { title: string; description: string; tags: string[] } | null {
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
