"use client";

import { useEffect, useState, type JSX } from "react";
import type { AutoSlotView } from "../../../../packages/contracts/src/publishing-automation";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StudioLink } from "../../components/studio-link";
import { Alert, Badge, Card } from "../../components/ui/primitives";
import { EmptyState, Skeleton } from "../../components/ui/studio";
import { stateLabel } from "../timeline/view-model";
import { autoSlots } from "./automation-api";
import { PageHeading } from "../../components/ui/page-heading";

function useSchedule(workspaceId: string): { slots: AutoSlotView[] | null; error: string } {
  const [slots, setSlots] = useState<AutoSlotView[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const values = await autoSlots(workspaceId);
        if (active) {
          setSlots(values);
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        if (active) timer = setTimeout(() => void load(), 30000);
      }
    };
    void load();
    return (): void => {
      active = false;
      clearTimeout(timer);
    };
  }, [workspaceId]);
  return { slots, error };
}

export function AutomationCalendar(): JSX.Element {
  const workspace = useActiveWorkspace();
  return <Schedule key={workspace.id} workspaceId={workspace.id} />;
}

function Schedule({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { slots, error } = useSchedule(workspaceId);
  return (
    <section className="rf-stack">
      <PageHeading label="03 / Delivery" title="Publishing schedule">
        Approved Shorts fill the next available channel slot. YouTube keeps them private until the
        scheduled time.
      </PageHeading>
      {error && (
        <Alert tone="danger" title="Schedule unavailable">
          {error}
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
