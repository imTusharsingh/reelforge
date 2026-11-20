"use client";

import { useRef, useState, type JSX } from "react";
import type { ChannelBrief } from "../../../../packages/contracts/src/foundations";
import { StudioLink } from "../../components/studio-link";
import { Alert, Button } from "../../components/ui/primitives";
import { Modal, Toast } from "../../components/ui/studio";
import { ensureCsrfToken } from "../../lib/csrf";
import { ChannelPicker } from "../brief/channel-picker";
import { BriefClient } from "../brief/client";
import type { Channel } from "../publishing/model";
import { PublishingScope } from "../publishing/session";

export function NewShort(): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [opened, setOpened] = useState(false);
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
          setOpened(true);
          dialog.current?.showModal();
        }}
      >
        ＋ New Short
      </Button>
      <Modal title="Create a Short" dialog={dialog} onClose={() => trigger.current?.focus()}>
        {opened && (
          <PublishingScope>
            <ChannelPicker disabled={locked}>
              {(channel) => <QueueShort key={channel.id} channel={channel} onBusy={setLocked} />}
            </ChannelPicker>
          </PublishingScope>
        )}
      </Modal>
    </div>
  );
}

function QueueShort({
  channel,
  onBusy,
}: {
  channel: Channel;
  onBusy: (busy: boolean) => void;
}): JSX.Element {
  const request = useRef<{ key: string; brief?: ChannelBrief }>({ key: "" });
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState("");
  const [error, setError] = useState("");
  const queue = async (): Promise<void> => {
    if (busy || run) return;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const client = new BriefClient(channel.workspaceId);
      const brief = request.current.brief ?? (await client.briefs(channel.id))[0];
      if (!brief) throw new Error("Save a Channel Brief in Settings to queue a Short.");
      request.current.brief = brief;
      request.current.key ||= crypto.randomUUID();
      await ensureCsrfToken();
      setRun((await client.queue(brief, request.current.key)).id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request could not be completed.");
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <div className="rf-stack">
      <p>Queue a run using this channel’s latest Brief and budget caps.</p>
      {error && (
        <Alert tone="danger" title="Short could not be queued">
          {error}
        </Alert>
      )}
      {run ? (
        <Toast>
          Short queued. <StudioLink href={`/runs/${run}`}>Open live run</StudioLink>
        </Toast>
      ) : (
        <Button loading={busy} onClick={() => void queue()}>
          Queue Short
        </Button>
      )}
    </div>
  );
}
