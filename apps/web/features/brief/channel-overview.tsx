"use client";
import { useCallback, type JSX } from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StudioLink } from "../../components/studio-link";
import { useResource } from "../../components/ui/use-resource";
import { BriefClient } from "./client";
export function ChannelOverview({ channelId }: { channelId: string }): JSX.Element {
  const workspace = useActiveWorkspace();
  const load = useCallback(
    () => new BriefClient(workspace.id).briefs(channelId),
    [workspace.id, channelId],
  );
  const { data, error } = useResource(load);
  const brief = data?.[0];
  return (
    <section className="rf-stack">
      <h1>Channel overview</h1>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p>Loading channel…</p>
      ) : brief ? (
        <>
          <h2>{brief.topic}</h2>
          <p>
            {brief.niche} · {brief.audience}
          </p>
          <p>
            {brief.targetDurationSeconds}-second Shorts in {brief.languages.narration}. Publishing
            at {brief.cadence.localTime} ({brief.cadence.timezone}).
          </p>
        </>
      ) : (
        <p>This channel has no saved Brief yet.</p>
      )}
      <StudioLink href={`/channels/${channelId}/brief`}>Open Channel Brief</StudioLink>
      <StudioLink href="/runs">View Shorts</StudioLink>
    </section>
  );
}
