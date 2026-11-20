"use client";

import { useId, type JSX, type ReactNode, type RefObject } from "react";
import { Button, Panel } from "./primitives";

export function Modal({ dialog, title, onClose, children }: {
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
        <Button tone="ghost" onClick={() => dialog.current?.close()}>Close</Button>
      </div>
      {children}
    </dialog>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return <Panel className="rf-empty"><h2>{title}</h2>{children}</Panel>;
}

export function Skeleton({ label }: { label: string }): JSX.Element {
  return <div role="status" className="rf-stack">{label}<div aria-hidden="true" className="rf-skeleton" /></div>;
}

export function Toast({ children }: { children: ReactNode }): JSX.Element {
  return <div role="status" className="rf-toast">{children}</div>;
}

export function VideoPlayer({ src, poster, label, preview = false }: {
  src?: string | undefined;
  poster?: string | undefined;
  label: string;
  preview?: boolean;
}): JSX.Element {
  return (
    <div className={preview ? "rf-frame rf-frame--preview" : "rf-frame"}>
      {src ? <video src={src} poster={poster} aria-label={label} controls={!preview} preload="metadata" playsInline />
        : poster ? <img src={poster} alt={label} loading="lazy" /> : <span>{label}</span>}
    </div>
  );
}
