"use client";
import { useEffect, useState, type JSX } from "react";
import type { AutoSlotView } from "../../../../packages/contracts/src/publishing-automation";
import { useActiveWorkspace } from "../../components/studio-workspace-context";
import { StudioLink } from "../../components/studio-link";
import { autoSlots } from "./automation-api";
export function AutomationCalendar(): JSX.Element {
  const workspace = useActiveWorkspace();
  const [slots, setSlots] = useState<AutoSlotView[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const values = await autoSlots(workspace.id);
        if (active) {
          setSlots(values);
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30000);
    return (): void => {
      active = false;
      clearInterval(timer);
    };
  }, [workspace.id]);
  return (
    <section aria-label="Automatic publishing slots">
      <h2>Automatic Shorts</h2>
      <p>
        Approved Shorts use the next free channel cadence slot. YouTube keeps them private until
        that time.
      </p>
      {error && <p role="alert">{error}</p>}
      {!slots.length && <p>No automatic publishing slots yet.</p>}
      <ul>
        {slots.map((slot) => (
          <li key={slot.id}>
            <StudioLink href={`/publishing/new?autoSlot=${slot.id}`}>
              {slot.package.title}
            </StudioLink>
            <p>
              {new Intl.DateTimeFormat("en", {
                timeZone: slot.timezone,
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(slot.scheduledAt))}{" "}
              ({slot.timezone}) · {slot.status}
            </p>
            {slot.lastError && (
              <p>
                {slot.lastError === "RECONNECT_YOUTUBE"
                  ? "Reconnect YouTube in Accounts, then reconcile this upload."
                  : "Preflight or upload reconciliation needs attention."}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
