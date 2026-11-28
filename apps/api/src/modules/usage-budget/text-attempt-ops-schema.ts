import { z } from "zod";
import { textSenderIdentity } from "./text-sender-identity.js";

const label = z.string().trim().min(1).max(240);
export const drainedLegacyIncarnation = "drained-legacy-writer";
const liveTarget = z.strictObject({
  workspaceId: z.uuid(),
  attemptId: z.uuid(),
  dispatchKey: z.string().min(1).max(240),
  armNonce: z.uuid(),
  incarnation: z.uuid(),
});
const legacyTarget = liveTarget.extend({
  armNonce: z.templateLiteral(["legacy:", z.uuid()]),
  incarnation: z.literal(drainedLegacyIncarnation),
});
export const textAttemptOpsTarget = z.union([liveTarget, legacyTarget]);
export type TextAttemptOpsTarget = z.infer<typeof textAttemptOpsTarget>;

const audit = {
  // An internal DB operator verifies the external record and files this reference.
  actor: label,
  reference: label,
};
export const textSenderRetirementProof = z.discriminatedUnion("source", [
  z.strictObject({
    ...audit,
    target: liveTarget,
    source: z.literal("local-procfs"),
  }),
  z.strictObject({
    ...audit,
    target: liveTarget,
    source: z.literal("supervisor-exit"),
    observedAt: z.iso.datetime({ offset: true }),
    result: z.literal("process-exited"),
    sender: textSenderIdentity,
  }),
]);
const providerAudit = {
  ...audit,
  target: textAttemptOpsTarget,
  source: z.enum(["google-project-audit", "egress-response"]),
  observedAt: z.iso.datetime({ offset: true }),
};
export const matchedTextReceipt = z.strictObject({
  ...providerAudit,
  googleId: z.string().trim().min(1).max(240),
  usage: z.record(z.string(), z.json()).optional(),
  actualMinor: z.int().nonnegative().max(2_147_483_647).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

export const matchedTextRejection = z.strictObject({
  ...providerAudit,
  httpStatus: z.int(),
  code: label,
});
