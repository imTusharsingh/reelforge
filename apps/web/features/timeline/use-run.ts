"use client";
import { useEffect, useState, useCallback } from "react";
import type { TimelineDetail } from "./client";
import { runClient, watchRun } from "./client";

export function useRun(
  workspaceId: string,
  id: string,
): {
  detail: TimelineDetail | null;
  error: string;
  connection: string;
  refresh: () => void;
} {
  const [detail, setDetail] = useState<TimelineDetail | null>(null);
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
  useEffect(() => {
    const timer = setInterval(refresh, connection === "Live" ? 240000 : 15000);
    return (): void => clearInterval(timer);
  }, [connection, refresh]);
  return { detail, error, connection, refresh };
}
