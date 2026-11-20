"use client";

import { useEffect, useState, type JSX } from "react";
import { z } from "zod";
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
    const schema = z.object({
      totals: z.object({
        currencies: z.array(
          z.object({
            currency: z.string(),
            reservedMinor: z.number(),
            committedMinor: z.number(),
          }),
        ),
      }),
    });
    void runRequest(`workspaces/${workspaceId}/usage/runs/${id}`, workspaceId)
      .then((data) => {
        if (!active) return;
        const usd = schema.parse(data).totals.currencies.find((item) => item.currency === "USD");
        setCost(usd ?? { reservedMinor: 0, committedMinor: 0 });
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
