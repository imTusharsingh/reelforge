"use client";
import { useEffect, useState, type JSX } from "react";
import type {
  RunAutonomyStatus,
  RunSummary,
} from "../../../../packages/contracts/src/run-experience";
import { Alert } from "../../components/ui/primitives";
import { runClient, runRequest } from "./client";

export function AutonomyPanel({
  workspaceId,
  run,
  editable,
  refresh,
}: {
  workspaceId: string;
  run: RunSummary;
  editable: boolean;
  refresh: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<RunAutonomyStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void runClient.status(workspaceId, run.id).then(
      (data) => {
        if (active) setStatus(data);
      },
      (e: unknown) => {
        if (active) setError(String(e));
      },
    );
    return (): void => {
      active = false;
    };
  }, [workspaceId, run.id]);
  const choose = async (requested: string): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      await runRequest(`run-experience/${run.id}/autonomy`, workspaceId, { requested });
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h2>Autonomy</h2>
      <p>
        Requested {run.requestedAutonomy} · Effective {run.effectiveAutonomy}
      </p>
      <AutonomyStatus status={status} />
      <AutonomySelection run={run} editable={editable} busy={busy} choose={choose} />
      {error && (
        <Alert tone="danger" title="Autonomy needs attention">
          {error}
        </Alert>
      )}
    </section>
  );
}

function AutonomyStatus({ status }: { status: RunAutonomyStatus | null }): JSX.Element {
  return (
    <>
      {" "}
      {status && (
        <>
          <p>
            {status.approvedShorts} approved Shorts for this channel. Critic agreement:{" "}
            {status.agreements}/{status.samples} recent taps
            {status.recommended ? " · L3 recommended" : ""}.
          </p>
          {status.approvedShorts < 10 ? (
            <p>L3 unlocks after 10 approved Shorts. L1 and L2 remain available.</p>
          ) : (
            <p>L3 is available by explicit opt-in. Every hard gate still applies.</p>
          )}
          {status.offerL3 && (
            <p>Try full auto (L3){status.recommended ? " — recommended at 8/10 or better" : ""}.</p>
          )}
        </>
      )}
    </>
  );
}

function AutonomySelection({
  run,
  editable,
  busy,
  choose,
}: {
  run: RunSummary;
  editable: boolean;
  busy: boolean;
  choose: (requested: string) => Promise<void>;
}): JSX.Element {
  return (
    <>
      {" "}
      {editable && run.state === "PLANNING" && (
        <label>
          Autonomy for this run{" "}
          <select
            disabled={busy}
            value={run.requestedAutonomy}
            onChange={(event) => void choose(event.target.value)}
          >
            <option value="L1">L1 — approve each stage</option>
            <option value="L2">L2 — approve before publish</option>
            <option value="L3" disabled={run.approvedShortsAtStart < 10}>
              L3 — full auto
            </option>
          </select>
        </label>
      )}
    </>
  );
}
