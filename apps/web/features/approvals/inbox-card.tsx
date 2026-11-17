"use client";
import type { JSX } from "react";
import { StudioLink } from "../../components/studio-link";
import { useRun } from "../timeline/use-run";
import { ApprovalPanel } from "./approval-panel";
export function InboxCard({
  id,
  workspaceId,
  editable,
}: {
  id: string;
  workspaceId: string;
  editable: boolean;
}): JSX.Element {
  const { detail, error, refresh } = useRun(workspaceId, id);
  return (
    <article>
      <StudioLink href={`/runs/${id}`}>Short {id.slice(0, 8)}</StudioLink>
      {error && <p role="alert">{error}</p>}
      {detail ? (
        <ApprovalPanel
          detail={detail}
          workspaceId={workspaceId}
          editable={editable}
          refresh={refresh}
        />
      ) : (
        <p>Loading report…</p>
      )}
    </article>
  );
}
