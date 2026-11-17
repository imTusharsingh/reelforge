"use client";
import { useEffect, useState, useCallback } from "react";
import type { RunDetailView } from "../../../../packages/contracts/src/run-experience";
import { runClient, watchRun } from "./client";

export function useRun(
  workspaceId: string,
  id: string,
): {
  detail: RunDetailView | null;
  error: string;
  connection: string;
  refresh: () => void;
} {
  const [detail, setDetail] = useState<RunDetailView | null>(null);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("Connecting…");
  const [version, setVersion] = useState(0);
  const refresh = useCallback((): void => {
    setVersion((v) => v + 1);
  }, []);
  useEffect(() => {
    let active = true;
    void runClient.detail(workspaceId, id).then(
      (value) => {
        if (active) {
          setDetail(value);
          setError("");
        }
      },
      (e: unknown) => {
        if (active) setError(String(e));
      },
    );
    return (): void => {
      active = false;
    };
  }, [workspaceId, id, version]);
  useEffect(() => watchRun(workspaceId, id, refresh, setConnection), [workspaceId, id, refresh]);
  return { detail, error, connection, refresh };
}
