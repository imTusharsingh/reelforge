"use client";

import { useEffect, useState, type JSX } from "react";
import { runRequest } from "./client";
import { dollars } from "./view-model";

export function RunCost({
  workspaceId,
  id,
  revision,
}: {
  workspaceId: string;
  id: string;
  revision?: object;
}): JSX.Element {
  const [cost, setCost] = useState<{ reservedMinor: number; committedMinor: number } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setError(false);
    void runRequest(`workspaces/${workspaceId}/usage/runs/${id}`, workspaceId)
      .then((data) => {
        if (!active) return;
        setCost(usdTotals(data));
      })
      .catch(() => {
        if (active) setError(true);
      });
    return (): void => {
      active = false;
    };
  }, [workspaceId, id, revision]);
  if (error) return <p role="alert">Run costs unavailable.</p>;
  if (!cost) return <p>Loading run costs…</p>;
  return (
    <p>
      {dollars(cost.reservedMinor)} reserved · {dollars(cost.committedMinor)} committed
    </p>
  );
}

function usdTotals(data: unknown): { reservedMinor: number; committedMinor: number } {
  if (typeof data !== "object" || data === null || !("totals" in data))
    throw new Error("Invalid run costs");
  const totals = data.totals;
  if (
    typeof totals !== "object" ||
    totals === null ||
    !("currencies" in totals) ||
    !Array.isArray(totals.currencies)
  )
    throw new Error("Invalid run cost currencies");
  for (const row of totals.currencies as unknown[]) {
    if (typeof row !== "object" || row === null || !("currency" in row) || row.currency !== "USD")
      continue;
    if (
      !("reservedMinor" in row) ||
      typeof row.reservedMinor !== "number" ||
      !("committedMinor" in row) ||
      typeof row.committedMinor !== "number"
    )
      throw new Error("Invalid USD totals");
    return { reservedMinor: row.reservedMinor, committedMinor: row.committedMinor };
  }
  return { reservedMinor: 0, committedMinor: 0 };
}
