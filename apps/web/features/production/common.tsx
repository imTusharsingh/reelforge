"use client";
import type { JSX, ReactNode } from "react";
import { Button, StateMessage } from "../../components/ui/primitives";
import type { LoadState } from "./session";

export function LoadResult<T>({
  state,
  empty,
  onRetry,
  children,
}: {
  state: LoadState<T>;
  empty?: boolean;
  onRetry?: () => void;
  children?: ReactNode;
}): JSX.Element {
  if (state.loading && state.data === null)
    return <StateMessage kind="loading" description="Loading persisted production data…" />;
  if (state.error)
    return (
      <StateMessage
        kind="error"
        description={state.error}
        action={onRetry ? <Button onClick={onRetry}>Try again</Button> : undefined}
      />
    );
  if (empty)
    return <StateMessage kind="empty" description="No persisted records match this view." />;
  return <>{children}</>;
}
