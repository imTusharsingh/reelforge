"use client";

import { useRef, useState, type JSX } from "react";
import type { ChannelBrief } from "../../../../packages/contracts/src/foundations";
import { StudioLink } from "../../components/studio-link";
import { Alert, Button } from "../../components/ui/primitives";
import { Modal } from "../../components/ui/studio";
import { Icon } from "../../components/ui/icon";
import { ensureCsrfToken } from "../../lib/csrf";
import { ChannelPicker } from "../brief/channel-picker";
import { BriefClient, UnsupportedNarrationLanguageError } from "../brief/client";
import type { Channel } from "../publishing/model";
import { PublishingScope } from "../publishing/session";

type QueuedAttempt = { key: string; brief: ChannelBrief };

export function NewShort(): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cycle = useRef(0);
  const [openedCycle, setOpenedCycle] = useState(0);
  const [attempts] = useState(() => new Map<string, QueuedAttempt>());
  const inFlight = useRef(false);
  const [locked, setLocked] = useState(false);
  return (
    <div className="rf-cluster">
      <StudioLink className="rf-button rf-button--secondary" href="/onboarding">
        New channel
      </StudioLink>
      <Button
        ref={trigger}
        aria-haspopup="dialog"
        onClick={() => {
          if (!dialog.current || dialog.current.open) return;
          dialog.current.showModal();
          setOpenedCycle(++cycle.current);
        }}
      >
        <Icon name="plus" /> New Short
      </Button>
      <Modal title="Create a Short" dialog={dialog} onClose={() => trigger.current?.focus()}>
        {openedCycle > 0 && (
          <PublishingScope>
            <ChannelPicker disabled={locked}>
              {(channel) => (
                <QueueShort
                  key={`${channel.workspaceId}:${channel.id}`}
                  channel={channel}
                  attempts={attempts}
                  openedCycle={openedCycle}
                  cycle={cycle}
                  inFlight={inFlight}
                  onBusy={setLocked}
                />
              )}
            </ChannelPicker>
          </PublishingScope>
        )}
      </Modal>
    </div>
  );
}

function QueueShort({
  channel,
  attempts,
  openedCycle,
  cycle,
  inFlight,
  onBusy,
}: {
  channel: Channel;
  attempts: Map<string, QueuedAttempt>;
  openedCycle: number;
  cycle: { current: number };
  inFlight: { current: boolean };
  onBusy: (busy: boolean) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<{ id: string; cycle: number }>();
  const run = queued?.cycle === openedCycle ? queued.id : "";
  const [error, setError] = useState("");
  const scope = `${channel.workspaceId}:${channel.id}`;
  const pending = attempts.has(scope);
  const queue = async (): Promise<void> => {
    if (inFlight.current || run) return;
    inFlight.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const id = await submitScopedAttempt(channel, attempts, scope);
      // Reopening while the same request is in flight must not discard its result.
      setQueued({ id, cycle: cycle.current });
    } catch (cause) {
      // This specific server rejection means no run exists for the pinned Brief.
      if (cause instanceof UnsupportedNarrationLanguageError) attempts.delete(scope);
      setError(cause instanceof Error ? cause.message : "The request could not be completed.");
    } finally {
      inFlight.current = false;
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <div className="rf-stack">
      <QueueShortStatus pending={pending} busy={busy} error={error} />
      {run ? (
        <Alert title="Short queued." tone="success">
          <StudioLink href={`/runs/${run}`}>Open live run</StudioLink>
        </Alert>
      ) : (
        <Button loading={busy} onClick={() => void queue()}>
          {pending ? "Retry earlier submission" : "Queue Short"}
        </Button>
      )}
    </div>
  );
}

function QueueShortStatus({
  pending,
  busy,
  error,
}: {
  pending: boolean;
  busy: boolean;
  error: string;
}): JSX.Element {
  if (pending) {
    return (
      <Alert
        tone={busy ? "info" : "warning"}
        title={busy ? "Checking submission" : "Earlier submission is unconfirmed"}
      >
        Retrying uses the original Channel Brief and won’t create a duplicate run.
      </Alert>
    );
  }
  return (
    <>
      <p>Queue a run using this channel’s latest Brief and budget caps.</p>
      {error && (
        <Alert tone="danger" title="Short could not be queued">
          {error}
        </Alert>
      )}
    </>
  );
}

async function submitScopedAttempt(
  channel: Channel,
  attempts: Map<string, QueuedAttempt>,
  scope: string,
): Promise<string> {
  const client = new BriefClient(channel.workspaceId);
  const pending = attempts.get(scope);
  const brief = pending?.brief ?? (await client.briefs(channel.id))[0];
  if (!brief) throw new Error("Save a Channel Brief in Settings to queue a Short.");
  const key = pending?.key ?? crypto.randomUUID();
  await ensureCsrfToken();
  attempts.set(scope, { key, brief });
  const { id } = await client.queue(brief, key);
  attempts.delete(scope);
  return id;
}
