"use client";
import { useEffect, useState, type JSX } from "react";
import { useSearchParams } from "next/navigation";
import type { AutoSlotView } from "../../../../packages/contracts/src/publishing-automation";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StudioLink } from "../../components/studio-link";
import { Alert, Button, Card, Field, TextAreaField } from "../../components/ui/primitives";
import { EmptyState, Skeleton } from "../../components/ui/studio";
import { autoSlot, automationRequest } from "./automation-api";
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
  const [slot, setSlot] = useState<AutoSlotView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void autoSlot(workspace.id, id).then(
      (value) => {
        if (active) setSlot(value);
      },
      (e: unknown) => {
        if (active) setError(String(e));
      },
    );
    return (): void => {
      active = false;
    };
  }, [workspace.id, id]);
  const retry = async (): Promise<void> => {
    if (!slot || busy) return;
    setBusy(true);
    setError("");
    try {
      await automationRequest(workspace.id, `/${slot.runId}/retry`, true);
      setSlot(await autoSlot(workspace.id, id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rf-stack">
      <header className="rf-page-heading">
        <h1>Scheduled Short</h1>
        <StudioLink href="/publishing">Back to schedule</StudioLink>
      </header>
      {error && (
        <Alert tone="danger" title="Publishing details unavailable">
          {error}
        </Alert>
      )}
      {slot ? (
        <>
          <PackagedMetadata slot={slot} />
          {slot.lastError === "RECONNECT_YOUTUBE" && (
            <ReconnectNotice editable={workspace.role !== "VIEWER"} busy={busy} retry={retry} />
          )}
        </>
      ) : !error ? (
        <Skeleton label="Loading packaged metadata…" />
      ) : null}
    </section>
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
