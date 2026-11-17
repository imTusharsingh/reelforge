"use client";
import { useEffect, useState, type JSX } from "react";
import { useSearchParams } from "next/navigation";
import type { AutoSlotView } from "../../../../packages/contracts/src/publishing-automation";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StudioLink } from "../../components/studio-link";
import { autoSlot, automationRequest } from "./automation-api";
import { Composer } from "./composer";
export function PublishingComposer(): JSX.Element {
  const id = useSearchParams().get("autoSlot");
  return id ? <AutomationComposer id={id} /> : <Composer />;
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
    <section>
      <h1>Automatic publishing composer</h1>
      {error && <p role="alert">{error}</p>}
      {slot ? (
        <>
          <PackagedMetadata slot={slot} />
          {slot.lastError === "RECONNECT_YOUTUBE" && (
            <>
              <p>
                Reconnect the existing YouTube account, then reconcile. This will reuse any saved
                upload session.
              </p>
              <StudioLink href="/publishing/accounts">Reconnect YouTube</StudioLink>
              {workspace.role !== "VIEWER" && (
                <button disabled={busy} onClick={() => void retry()}>
                  Reconcile after reconnect
                </button>
              )}
            </>
          )}
        </>
      ) : (
        <p role="status">Loading packaged metadata…</p>
      )}
    </section>
  );
}

function PackagedMetadata({ slot }: { slot: AutoSlotView }): JSX.Element {
  return (
    <>
      {" "}
      <p>
        {slot.status} · {slot.timezone} · {slot.scheduledAt}
      </p>
      <label>
        Packaged title
        <input readOnly value={slot.package.title} />
      </label>
      <label>
        Packaged description
        <textarea readOnly value={slot.package.description} />
      </label>
      <p>Tags: {slot.package.tags.join(", ")}</p>
      <p>AI disclosure: always on · Private until the scheduled slot.</p>
      {slot.scheduledPostId && (
        <StudioLink href={`/publishing/posts/${slot.scheduledPostId}`}>
          Open saved post and reconciliation
        </StudioLink>
      )}
    </>
  );
}
