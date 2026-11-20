import type { JSX } from "react";
import { ShotSpecSchema } from "../../../../packages/contracts/src/foundations";
import type { RunDetailView } from "../../../../packages/contracts/src/run-experience";
import { Badge, Button, Card } from "../../components/ui/primitives";
import { EmptyState, VideoPlayer } from "../../components/ui/studio";
import { dollars, stateLabel } from "./view-model";

export function Storyboard({ detail, onRedo, busy }: {
  detail: RunDetailView;
  onRedo?: ((ordinal: number) => void) | undefined;
  busy: boolean;
}): JSX.Element {
  const latest = new Map<string, RunDetailView["steps"][number]>();
  for (const step of detail.steps) {
    if (!step.key.startsWith("shot-")) continue;
    const previous = latest.get(step.key);
    if (!previous || previous.attempt < step.attempt) latest.set(step.key, step);
  }
  const shots = [...latest.values()].sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
  return (
    <section id="storyboard" className="rf-stack" tabIndex={-1}>
      <h2>Storyboard</h2>
      {shots.length === 0 && <EmptyState title="No shots yet"><p>Shot previews appear after planning.</p></EmptyState>}
      <div className="rf-grid">{shots.map((step) => (
        <ShotCard key={step.id} step={step} media={detail.artifactUrls.find((entry) => entry.stepId === step.id)?.artifacts ?? []} onRedo={onRedo} busy={busy} />
      ))}</div>
    </section>
  );
}

function ShotCard({ step, media, onRedo, busy }: {
  step: RunDetailView["steps"][number];
  media: RunDetailView["artifactUrls"][number]["artifacts"];
  onRedo: ((ordinal: number) => void) | undefined;
  busy: boolean;
}): JSX.Element {
  const shot = ShotSpecSchema.safeParse(step.input);
  const clip = media.find((item) => item.contentType === "video/mp4");
  const poster = media.find((item) => item.contentType.startsWith("image/"));
  return (
    <Card className="rf-shot">
      <VideoPlayer src={clip?.url} poster={poster?.url} label={clip || poster ? `Preview of ${step.key}` : "Clip not ready"} />
      <h3>{shot.success ? `Shot ${shot.data.ordinal + 1}` : step.key}</h3>
      <Badge>{stateLabel(step.state)}</Badge>
      <p>Attempt {step.attempt}{step.costMinor === null ? "" : ` · ${dollars(step.costMinor)}`}</p>
      {shot.success && shot.data.voLine && <p>{shot.data.voLine}</p>}
      {onRedo && shot.success && <Button tone="secondary" disabled={busy || step.attempt >= 3} onClick={() => onRedo(shot.data.ordinal)}>Redo shot</Button>}
    </Card>
  );
}
