"use client";
import { useEffect, useState, type JSX } from "react";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StudioLink } from "../../components/studio-link";
import { runClient } from "../timeline/client";
import { dollars } from "../timeline/view-model";
export function UsageScreen(): JSX.Element {
  const workspace = useActiveWorkspace();
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof runClient.usage>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void runClient.usage(workspace.id).then(
      (data) => {
        if (active) setUsage(data);
      },
      (e: unknown) => {
        if (active) setError(String(e));
      },
    );
    return (): void => {
      active = false;
    };
  }, [workspace.id]);
  return (
    <section>
      <h1>Usage</h1>
      <p>Recorded spend in USD, including all shot attempts.</p>
      {error && <p role="alert">{error}</p>}
      {!usage && !error && <p role="status">Loading usage…</p>}
      <h2>Cost per Short</h2>
      <ul>
        {usage?.shorts.map((s) => (
          <li key={s.runId}>
            <StudioLink href={`/runs/${s.runId}`}>{s.runId.slice(0, 8)}</StudioLink>:{" "}
            {dollars(s.costMinor)}
          </li>
        ))}
      </ul>
      <h2>Cost per provider</h2>
      <ul>
        {usage?.providers.map((p) => (
          <li key={p.providerId}>
            {p.providerId}: {dollars(p.costMinor)}
          </li>
        ))}
      </ul>
    </section>
  );
}
