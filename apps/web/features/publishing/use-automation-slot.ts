"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AutoSlotView } from "../../../../packages/contracts/src/publishing-automation";
import { useNotify } from "../../components/ui/notifications";
import { autoSlot, automationRequest } from "./automation-api";

type SlotControls = {
  slot: AutoSlotView | null;
  error: string;
  busy: boolean;
  reload: () => void;
  retry: () => Promise<void>;
};

export function useAutomationSlot(workspaceId: string, id: string): SlotControls {
  const notify = useNotify();
  const scope = useRef<AbortController>(null);
  const [slot, setSlot] = useState<AutoSlotView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const read = useCallback(
    async (signal: AbortSignal): Promise<boolean> => {
      setError("");
      setSlot(null);
      try {
        const next = await autoSlot(workspaceId, id, signal);
        if (signal.aborted) return false;
        setSlot(next);
        return true;
      } catch (e) {
        if (!signal.aborted) setError(message(e));
        return false;
      }
    },
    [workspaceId, id],
  );
  useLayoutEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    void read(controller.signal);
    return (): void => controller.abort();
  }, [read]);
  const reload = (): void => {
    if (scope.current && !scope.current.signal.aborted) void read(scope.current.signal);
  };
  const retry = async (): Promise<void> => {
    const signal = scope.current?.signal;
    if (!signal || signal.aborted || busy || slot?.lastError !== "RECONNECT_YOUTUBE") return;
    setBusy(true);
    try {
      await automationRequest(
        workspaceId,
        `/${encodeURIComponent(slot.runId)}/retry`,
        true,
        signal,
      );
      if (!signal.aborted && (await read(signal)) && !signal.aborted) {
        notify({ tone: "info", title: "Publishing status refreshed." });
      }
    } catch (e) {
      if (!signal.aborted) {
        notify({
          tone: "danger",
          title: "Reconciliation could not be confirmed",
          detail: message(e),
        });
        await read(signal);
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  return { slot, error, busy, reload, retry };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Check the connection and try again.";
}
