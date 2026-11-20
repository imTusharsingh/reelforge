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
    .filter((s) => s.key === "CRITIC")
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
  const media = detail.artifactUrls.flatMap((entry) => entry.artifacts).reverse();
  const video = media.find((item) => item.kind === "final" && item.contentType === "video/mp4");
  const poster = media.find((item) => ["cover", "thumbnail", "poster"].includes(item.kind) && item.contentType.startsWith("image/"));
  return { ...(video && { video: video.url }), ...(poster && { poster: poster.url }) };
}
