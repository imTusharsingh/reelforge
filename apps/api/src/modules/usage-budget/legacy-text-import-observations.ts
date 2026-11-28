import type { Prisma } from "@reelforge/database";
import { z } from "zod";
import type { Event, Step, Transaction } from "../runs/runs.types.js";
import type { LegacyTextSource } from "./legacy-text-import-evidence.js";
import { keyMatches, legacyObject } from "./legacy-text-import-fields.js";

const remote = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,256}$/u);
const counterObject = z.record(z.string(), z.json());
const attached = z.object({
  output: z.json(),
  providerJobId: remote.nullish(),
  dispatchKey: z.string().optional(),
  usage: counterObject.optional(),
});
const ownerProof = z.object({
  reason: z.literal("OWNER_CONFIRMED_TERMINAL_TEXT"),
  confirmedBy: z.uuid(),
  committedEstimateMinor: z.int().nonnegative(),
});
const ownerReceipt = z.object({
  providerJobId: remote,
  usage: counterObject.optional(),
});
type Observation = { id: string; data: Prisma.InputJsonObject };
type Observations = {
  send?: string;
  outcome?: Observation & { kind: "SUCCEEDED" | "REJECTED" };
  owner?: { id: string; confirmedBy: string };
  recovered: Observation[];
};
type Source = LegacyTextSource & { request: NonNullable<LegacyTextSource["request"]> };

function completedOutput(source: Source): z.infer<typeof attached> | undefined {
  for (const stored of [source.step.output, legacyObject(source.step.output).result]) {
    const value = attached.safeParse(stored).data;
    if (!value) continue;
    const { dispatchKey, providerJobId } = value;
    if (
      dispatchKey === source.step.idempotencyKey ||
      (dispatchKey === undefined &&
        (providerJobId === source.step.idempotencyKey ||
          (providerJobId !== undefined &&
            providerJobId !== null &&
            providerJobId === source.step.providerJobId)))
    )
      return value;
  }
}
function providerIds(
  source: Source,
  activity: Event[],
  completion?: z.infer<typeof attached>,
): string[] {
  const metadata = legacyObject(source.request.responseMetadata);
  const candidates = [
    source.step.providerJobId,
    metadata.dispatched === true ? metadata.providerJobId : null,
    completion?.providerJobId,
    ...activity.flatMap((event) => {
      const payload = legacyObject(event.payload);
      return ["provider_submitted", "text_evidence_recorded"].includes(event.type) &&
        keyMatches(payload, source.step.idempotencyKey) &&
        payload.source !== "owner_reported"
        ? [payload.providerJobId]
        : [];
    }),
  ];
  return [
    ...new Set(
      candidates.flatMap((value) => {
        const candidate = remote.safeParse(value).data;
        return candidate && candidate !== source.step.idempotencyKey ? [candidate] : [];
      }),
    ),
  ];
}
function definitiveRejection(source: Source, activity: Event[], zero: boolean): string | undefined {
  if (!zero) return;
  const known = ["PROVIDER_UNAUTHENTICATED", "PROVIDER_PERMISSION_DENIED"];
  const code = legacyObject(source.step.error).code;
  if (typeof code === "string" && known.includes(code)) return code;
  const event = activity.find(
    ({ type, payload }) =>
      type === "text_rejection_reconciled" &&
      keyMatches(payload, source.step.idempotencyKey) &&
      known.includes(String(legacyObject(payload).reason)),
  );
  if (event) return String(legacyObject(event.payload).reason);
}

function originalOwner(source: Source, events: Event[]): Observations["owner"] {
  const estimates = events.flatMap((event) => {
    const proof = event.type === "step_failed" && ownerProof.safeParse(event.payload).data;
    return proof && BigInt(proof.committedEstimateMinor) === source.reservation?.amountMinor
      ? [{ id: event.id, confirmedBy: proof.confirmedBy }]
      : [];
  });
  return estimates[0];
}

function usageData(
  source: Source,
  completion?: z.infer<typeof attached>,
): Prisma.InputJsonObject | null {
  const usage = counterObject.safeParse(source.request.usage).data;
  if (!usage) return completion?.usage ?? null;
  if (
    Object.entries(completion?.usage ?? {}).some(
      ([key, value]) =>
        Object.hasOwn(usage, key) && JSON.stringify(value) !== JSON.stringify(usage[key]),
    )
  )
    return null;
  return { ...completion?.usage, ...usage };
}

export function extractLegacyObservations(
  input: LegacyTextSource,
  activity: Event[],
  zero: boolean,
): Observations | { reason: string } {
  const source = input as Source; // identity and presence checked by the planner before classification
  const { step, request } = source;
  const dispatchKey = step.idempotencyKey;
  const saved = completedOutput(source);
  const ids = providerIds(source, activity, saved);
  if (ids.length > 1) return { reason: "legacy Google interaction IDs conflict" };
  const [googleId] = ids;
  const usage = usageData(source, saved);
  if (usage === null && (saved?.usage || counterObject.safeParse(request.usage).success))
    return { reason: "legacy usage counters conflict" };
  const owner = originalOwner(source, activity);
  const rejected = definitiveRejection(source, activity, zero);
  const invalid =
    request.errorCode === "PROVIDER_INVALID_OUTPUT" ||
    (request.errorCode === "PROVIDER_JOB_FAILED" &&
      legacyObject(step.error).code === "PROVIDER_INVALID");
  const complete = invalid || request.status === "SUCCEEDED" || !!saved;
  if (rejected && complete) return { reason: "legacy rejection and completion conflict" };
  const recovered = recoveredReceipts(source, googleId, usage, complete);
  const sent = activity.find(
    (event) => event.type === "text_dispatch_started" && keyMatches(event.payload, dispatchKey),
  );
  const send = sent?.id ?? (googleId || complete || rejected ? request.id : undefined);
  const outcome = concluded(source, saved, usage, googleId, rejected, invalid, complete);
  return { ...(send && { send }), ...(owner && { owner }), recovered, ...(outcome && { outcome }) };
}

function concluded(
  source: Source,
  saved: z.infer<typeof attached> | undefined,
  usage: Prisma.InputJsonObject | null,
  googleId: string | undefined,
  rejected: string | undefined,
  invalid: boolean,
  complete: boolean,
): Observations["outcome"] {
  const { step, request } = source;
  const dispatchKey = step.idempotencyKey;
  // Main committed the configured estimate and called it costKnown. Its text
  // writer never persisted a separately verified monetary amount.
  if (rejected)
    return {
      kind: "REJECTED",
      id: request.id,
      data: { dispatchKey, code: rejected, source: "matched-provider" },
    };
  if (complete)
    return {
      kind: "SUCCEEDED",
      id: saved ? step.id : request.id,
      data: {
        dispatchKey,
        usable: !invalid && saved?.output != null,
        ...(saved && { output: saved.output }),
        ...(googleId && { googleId }),
        ...(usage && { usage }),
      },
    };
}

function recoveredReceipts(
  { step, request }: Source,
  googleId: string | undefined,
  usage: Prisma.InputJsonObject | null,
  complete: boolean,
): Observation[] {
  const { idempotencyKey: dispatchKey } = step;
  const metadata = legacyObject(request.responseMetadata);
  const owner = ownerReceipt.safeParse(metadata.ownerReportedEvidence).data;
  const result: Observation[] = [];
  if (owner && owner.providerJobId !== dispatchKey)
    result.push({
      id: `${request.id}:owner`,
      data: {
        dispatchKey,
        source: "owner_reported",
        googleId: owner.providerJobId,
        ...(owner.usage && { usage: owner.usage }),
      },
    });
  if (!complete && (googleId || usage) && metadata.dispatched === true)
    result.push({
      id: request.id,
      data: {
        dispatchKey,
        source: "matched-provider",
        ...(googleId && { googleId }),
        ...(usage && { usage }),
      },
    });
  return result;
}

export function mainBudgetDenial(
  step: Step,
  activity: { type: string; payload: unknown }[],
): boolean {
  return (
    step.state === "CANCELLED" &&
    !!step.finishedAt &&
    !step.providerJobId &&
    step.providerId === "gemini" &&
    step.costMinor !== null &&
    step.costMinor >= 0 &&
    legacyObject(step.output).closedBy === "BUDGET_DENIED_NOT_DISPATCHED" &&
    activity.some(({ type, payload }) => {
      const release = legacyObject(payload);
      return (
        type === "dispatch_released" &&
        release.reason === "NOT_DISPATCHED" &&
        release.amountMinor === step.costMinor
      );
    }) &&
    !activity.some(({ type }) =>
      [
        "text_dispatch_started",
        "provider_dispatch",
        "provider_submitted",
        "reconcile_required",
        "text_evidence_recorded",
        "media_completed",
        "step_completed",
      ].includes(type),
    )
  );
}

export async function preserveMainEstimate(
  tx: Transaction,
  request: Pick<Source["request"], "id" | "actualCost" | "responseMetadata">,
): Promise<void> {
  if (request.actualCost !== null)
    await tx.providerRequest.update({
      where: { id: request.id },
      data: {
        actualCost: null,
        responseMetadata: {
          ...legacyObject(request.responseMetadata),
          costKnown: false,
          costBasis: "RESERVATION",
        },
      },
    });
}
