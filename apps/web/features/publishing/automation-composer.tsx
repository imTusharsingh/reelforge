"use client";
import type { JSX } from "react";
import { useSearchParams } from "next/navigation";
import type { AutoSlotView } from "../../../../packages/contracts/src/publishing-automation";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StudioLink } from "../../components/studio-link";
import { PageHeading } from "../../components/ui/page-heading";
import { Alert, Button, Card, Field, TextAreaField } from "../../components/ui/primitives";
import { EmptyState, Skeleton } from "../../components/ui/studio";
import { useAutomationSlot } from "./use-automation-slot";
export function PublishingComposer(): JSX.Element {
  const id = useSearchParams().get("autoSlot");
  return id ? (
    <AutomationComposer id={id} />
  ) : (
    <EmptyState title="No scheduled Short selected">
      <StudioLink href="/publishing">Open schedule</StudioLink>
    </EmptyState>
  );
}
export function AutomationComposer({ id }: { id: string }): JSX.Element {
  const workspace = useActiveWorkspace();
  return (
    <ScopedComposer
      key={JSON.stringify([workspace.id, workspace.role, id])}
      workspaceId={workspace.id}
      id={id}
      editable={workspace.role !== "VIEWER"}
    />
  );
}

function ScopedComposer({
  workspaceId,
  id,
  editable,
}: {
  workspaceId: string;
  id: string;
  editable: boolean;
}): JSX.Element {
  const { slot, error, busy, retry, reload } = useAutomationSlot(workspaceId, id);
  return (
    <section className="rf-stack">
      <ScheduledShortHeading />
      {error && (
        <Alert tone="danger" title="Publishing details unavailable">
          <p>{error}</p>
          <Button onClick={reload}>Reload publishing details</Button>
        </Alert>
      )}
      {slot ? (
        <>
          <PackagedMetadata slot={slot} />
          {slot.lastError === "YOUTUBE_SLOT_MISSED" && (
            <Alert tone="warning" title="YouTube slot missed">
              This slot passed. ReelForge won’t send a late upload.
            </Alert>
          )}
          {slot.lastError === "RECONNECT_YOUTUBE" && (
            <ReconnectNotice editable={editable} busy={busy} retry={retry} />
          )}
        </>
      ) : !error ? (
        <Skeleton label="Loading packaged metadata…" />
      ) : null}
    </section>
  );
}

function ScheduledShortHeading(): JSX.Element {
  return (
    <PageHeading
      label="03 / Delivery"
      title="Scheduled Short"
      actions={
        <StudioLink className="rf-button rf-button--secondary" href="/publishing">
          Back to schedule
        </StudioLink>
      }
    />
  );
}

function ReconnectNotice({
  editable,
  busy,
  retry,
}: {
  editable: boolean;
  busy: boolean;
  retry: () => Promise<void>;
}): JSX.Element {
  return (
    <Card>
      <h2>Reconnect YouTube</h2>
      <p>Reconnect the existing YouTube account, then reconcile the saved upload session.</p>
      <div className="rf-actions">
        <StudioLink href="/publishing/accounts">Reconnect YouTube</StudioLink>
        {editable && (
          <Button loading={busy} onClick={() => void retry()}>
            Reconcile after reconnect
          </Button>
        )}
      </div>
    </Card>
  );
}

function PackagedMetadata({ slot }: { slot: AutoSlotView }): JSX.Element {
  return (
    <Card>
      <p>
        {slot.status} · {slot.timezone} · {slot.scheduledAt}
      </p>
      <Field id="packaged-title" label="Packaged title" readOnly value={slot.package.title} />
      <TextAreaField
        id="packaged-description"
        label="Packaged description"
        readOnly
        value={slot.package.description}
      />
      <p>Tags: {slot.package.tags.join(", ")}</p>
      <p>AI disclosure: always on · Private until the scheduled slot.</p>
      {slot.scheduledPostId && (
        <StudioLink href={`/publishing/posts/${slot.scheduledPostId}`}>
          Open saved post and reconciliation
        </StudioLink>
      )}
    </Card>
  );
}
