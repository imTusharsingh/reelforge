"use client";

import { useCallback, type JSX } from "react";
import type { AutoSlotView } from "../../../../packages/contracts/src/publishing-automation";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StudioLink } from "../../components/studio-link";
import { Alert, Badge, Button, Card } from "../../components/ui/primitives";
import { EmptyState, Skeleton } from "../../components/ui/studio";
import { stateLabel } from "../timeline/view-model";
import { autoSlots } from "./automation-api";
import { useResource } from "../../components/ui/use-resource";
import { PageHeading } from "../../components/ui/page-heading";

export function AutomationCalendar(): JSX.Element {
  const workspace = useActiveWorkspace();
  return <Schedule key={workspace.id} workspaceId={workspace.id} />;
}

function Schedule({ workspaceId }: { workspaceId: string }): JSX.Element {
  const load = useCallback(() => autoSlots(workspaceId), [workspaceId]);
  const { data: slots, error, loading, retry } = useResource(load, 30000);
  return (
    <section className="rf-stack">
      <PageHeading label="03 / Delivery" title="Publishing schedule">
        Approved Shorts fill the next available channel slot. YouTube keeps them private until the
        scheduled time.
      </PageHeading>
      {error && (
        <Alert
          tone={slots ? "warning" : "danger"}
          title={slots ? "Couldn’t refresh schedule" : "Schedule unavailable"}
        >
          {slots ? "Showing the last loaded publishing slots." : error}
          <div className="rf-action-row">
            <Button tone="secondary" loading={loading} onClick={retry}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {!slots && !error && <Skeleton label="Loading publishing schedule…" />}
      {slots?.length === 0 && (
        <EmptyState title="No automatic publishing slots yet">
          <p>Approved Shorts appear here when a publishing slot is reserved.</p>
          <StudioLink href="/approvals">Open review queue</StudioLink>
        </EmptyState>
      )}
      {slots && slots.length > 0 && (
        <ol className="rf-schedule">
          {slots.map((slot) => (
            <li key={slot.id}>
              <ScheduleSlot slot={slot} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ScheduleSlot({ slot }: { slot: AutoSlotView }): JSX.Element {
  const date = new Date(slot.scheduledAt);
  const format = (options: Intl.DateTimeFormatOptions): string => {
    try {
      return new Intl.DateTimeFormat(undefined, { ...options, timeZone: slot.timezone }).format(
        date,
      );
    } catch {
      return slot.scheduledAt;
    }
  };
  return (
    <Card className="rf-schedule-slot">
      <div>
        <strong>
          {format({ weekday: "short", month: "short", day: "numeric", year: "numeric" })}
        </strong>
        <p>
          <time dateTime={slot.scheduledAt}>{format({ timeStyle: "short" })}</time> ·{" "}
          {slot.timezone}
        </p>
      </div>
      <div>
        <h2>
          <StudioLink href={`/publishing/new?autoSlot=${slot.id}`}>{slot.package.title}</StudioLink>
        </h2>
        <p>YouTube Shorts</p>
        {slot.lastError && (
          <p>
            {slot.lastError === "RECONNECT_YOUTUBE"
              ? "Reconnect YouTube to continue."
              : slot.lastError === "YOUTUBE_SLOT_MISSED"
                ? "This slot passed. ReelForge won’t send a late upload."
                : "Preflight or upload reconciliation needs attention."}
          </p>
        )}
      </div>
      <Badge tone={slot.lastError ? "warning" : "neutral"}>
        {slot.status === "DRY_RUN" ? "Dry run" : stateLabel(slot.status)}
      </Badge>
    </Card>
  );
}
