"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Resource<T> = {
  data: T | null;
  error: string;
  loading: boolean;
  retry: () => void;
};

/** Keep existing data on refresh failure and never overlap or reuse an out-of-scope response. */
export function useResource<T>(load: () => Promise<T>, pollMs?: number): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useRef<() => void>(() => undefined);
  const retry = useCallback(() => refresh.current(), []);
  useEffect(() => {
    let active = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = async (manual = false): Promise<void> => {
      if (busy || !active) return;
      busy = true;
      clearTimeout(timer);
      if (manual) setLoading(true);
      try {
        const result = await load();
        if (active) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "The request could not be completed.");
      } finally {
        busy = false;
        if (active) {
          setLoading(false);
          if (pollMs !== undefined) timer = setTimeout(() => void request(), pollMs);
        }
      }
    };
    refresh.current = (): void => void request(true);
    void request(true);
    return (): void => {
      active = false;
      clearTimeout(timer);
    };
  }, [load, pollMs]);
  return { data, error, loading, retry };
}
