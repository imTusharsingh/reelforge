"use client";

import { useId, useState, type JSX, type ReactNode, type RefObject } from "react";
import { Button, Panel } from "./primitives";
import { Icon } from "./icon";

export function Modal({
  dialog,
  title,
  onClose,
  children,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  title: string;
  onClose?: () => void;
  children: ReactNode;
}): JSX.Element {
  const id = useId();
  return (
    <dialog className="rf-dialog" ref={dialog} aria-labelledby={id} onClose={onClose}>
      <div className="rf-toolbar">
        <h2 id={id}>{title}</h2>
        <Button tone="ghost" onClick={() => dialog.current?.close()}>
          Close
        </Button>
      </div>
      {children}
    </dialog>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Panel className="rf-empty">
      <span className="rf-empty-icon" aria-hidden="true">
        <Icon name="film" />
      </span>
      <h2>{title}</h2>
      {children}
    </Panel>
  );
}

export function Skeleton({ label }: { label: string }): JSX.Element {
  return (
    <div role="status" className="rf-loading-state" aria-atomic="true">
      <span className="rf-loading-label">
        <span className="rf-spinner" aria-hidden="true" />
        {label}
      </span>
      <span aria-hidden="true" className="rf-skeleton">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

export function VideoPlayer({
  src,
  poster,
  label,
  preview = false,
}: {
  src?: string | undefined;
  poster?: string | undefined;
  label: string;
  preview?: boolean;
}): JSX.Element {
  const [failedVideo, setFailedVideo] = useState<string>();
  const [failedPoster, setFailedPoster] = useState<string>();
  const playable = Boolean(src && src !== failedVideo);
  const image = Boolean(poster && poster !== failedPoster && (!playable || preview));
  return (
    <div className={preview ? "rf-frame rf-frame--preview" : "rf-frame"}>
      {playable && !(preview && image) ? (
        <video
          src={src}
          poster={poster}
          aria-label={label}
          controls={!preview}
          preload="metadata"
          onError={() => setFailedVideo(src)}
          playsInline
        />
      ) : image ? (
        <img src={poster} alt={label} loading="lazy" onError={() => setFailedPoster(poster)} />
      ) : (
        <span className="rf-frame-label">
          <Icon name="film" />
          {failedVideo || failedPoster ? "Media unavailable" : label}
        </span>
      )}
    </div>
  );
}
