"use client";

import { useCallback, type JSX } from "react";
import { RankedIdeaSchema, type RankedIdea } from "../../../../packages/contracts/src/discovery";
import { Alert, Badge, Button, Card } from "../../components/ui/primitives";
import { EmptyState, Skeleton } from "../../components/ui/studio";
import { ChannelPicker } from "../brief/channel-picker";
import { LearnedChanges } from "../insights/learned-changes";
import type { Channel } from "../publishing/model";
import { useResource } from "../../components/ui/use-resource";
import { PageHeading } from "../../components/ui/page-heading";

export function Ideas(): JSX.Element {
  return (
    <section className="rf-stack">
      <PageHeading label="04 / Research" title="Ideas & discovery">
        Explore ranked topics and source material from your channel’s latest discovery scan.
      </PageHeading>
      <ChannelPicker>
        {(channel) => <ChannelIdeas key={channel.id} channel={channel} />}
      </ChannelPicker>
    </section>
  );
}

function ChannelIdeas({ channel }: { channel: Channel }): JSX.Element {
  const load = useCallback(async (): Promise<RankedIdea[]> => {
    const path = `/api/v1/workspaces/${encodeURIComponent(channel.workspaceId)}/channels/${encodeURIComponent(channel.id)}/learning/ideas`;
    const response = await fetch(path, { credentials: "include" });
    if (!response.ok) throw new Error("The latest discovery results could not be loaded.");
    return RankedIdeaSchema.array().parse(await response.json());
  }, [channel.id, channel.workspaceId]);
  const { data: ideas, error, loading, retry } = useResource(load);
  return (
    <div className="rf-stack">
      {error && (
        <Alert tone="danger" title="Discovery unavailable">
          The latest discovery results could not be loaded.
          <div className="rf-action-row">
            <Button tone="secondary" loading={loading} onClick={retry}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {!error && !ideas && <Skeleton label="Loading discovery results…" />}
      {ideas?.length === 0 && (
        <EmptyState title="No ideas in the latest scan">
          <p>Ideas appear here after discovery finds new topics that fit this channel.</p>
        </EmptyState>
      )}
      {ideas && ideas.length > 0 && (
        <div className="rf-ideas">
          {ideas.map((idea) => (
            <IdeaCard key={idea.id} idea={idea} />
          ))}
        </div>
      )}
      <LearnedChanges workspaceId={channel.workspaceId} channelId={channel.id} />
    </div>
  );
}

function IdeaCard({ idea }: { idea: RankedIdea }): JSX.Element {
  return (
    <Card>
      <div className="rf-cluster">
        <Badge>{idea.formatKey}</Badge>
        <Badge tone="info">{Math.round(idea.score * 100)}% score</Badge>
      </div>
      <h2>{idea.topic}</h2>
      <p>
        <strong>Hook</strong> {idea.hook}
      </p>
      <p>{idea.angle}</p>
      <details>
        <summary>Sources ({idea.sources.length})</summary>
        <ul>
          {idea.sources.map((source, index) => (
            <li key={`${source.url}:${index}`}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title} <span className="rf-muted">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}
