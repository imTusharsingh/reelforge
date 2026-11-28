import { InvalidCompletedText, ProviderFailure } from "@reelforge/ai-providers";
import { z } from "zod";
import type { TextPort } from "../reference-library/planning.ports.js";
import { planningPromptReceiptSchema } from "../script/planning.service.js";
import type { Context, Step } from "../runs/runs.types.js";
import {
  InvalidCompletedScript,
  isScriptRepair,
  validationMessage,
} from "../script/script-repair.js";
import { paidTextEnabled, type PaidTextResult } from "../usage-budget/text-attempt-runtime.js";
import type { MediaAccounts } from "./media-accounts.js";
import type { MediaPorts } from "./media-ports.js";

const repairSpec = z.object({
  repairOf: z.uuid(),
  prompt: z.string(),
  promptVersion: planningPromptReceiptSchema,
});
// A provably unsent repair keeps its original prompt and repair identity across restarts.
export function savedRepairSpec(step: Step): z.infer<typeof repairSpec> | undefined {
  if (isScriptRepair(step)) return z.object({ spec: repairSpec }).parse(step.input).spec;
}

export type PlanningTextInput = Parameters<TextPort["generate"]>[0];

export function replayPlanningText(step: Step): PaidTextResult {
  const saved = z
    .object({
      output: z.json(),
      providerJobId: z.string().nullable(),
      dispatchKey: z.string().optional(),
      usage: z.record(z.string(), z.unknown()),
    })
    .safeParse(step.output);
  if (!saved.success || (saved.data.dispatchKey && saved.data.dispatchKey !== step.idempotencyKey))
    throw new Error(`RECONCILE_REQUIRED: text submission outcome unknown (${step.id})`);
  return {
    ...saved.data,
    dispatchKey: step.idempotencyKey,
    providerJobId:
      saved.data.providerJobId === step.idempotencyKey ? null : saved.data.providerJobId,
  };
}

export async function dispatchPlanningText(
  ports: MediaPorts,
  accounts: MediaAccounts,
  context: Context,
  step: Step,
  input: PlanningTextInput,
): Promise<PaidTextResult> {
  // Resolve local configuration before the final run/stop check at the transport boundary.
  const native = paidTextEnabled()
    ? await ports
        .get(context)
        .catch((error: unknown) => accounts.refuseTextPreparation(context, step, error))
    : null;
  const transport = native?.text.completePaid?.bind(native.text);
  const writer = input.promptVersion.role === "scriptwriter";
  const spec = {
    prompt: input.prompt,
    jsonSchema: z.toJSONSchema(input.schema),
    parse: (value: unknown): unknown => (writer ? value : input.schema.parse(value)),
  };
  return accounts.dispatchTextAttempt(context, step, async (sent) => {
    if (!transport) throw new ProviderFailure("NOT_CONFIGURED", false);
    const result = await transport(spec, step.idempotencyKey, sent).catch((error: unknown) => {
      if (
        writer &&
        error instanceof InvalidCompletedText &&
        error.dispatchKey === step.idempotencyKey
      )
        throw new InvalidCompletedScript(
          error,
          step.idempotencyKey,
          "Expected a valid JSON script",
        );
      throw error;
    });
    if (writer && result.dispatchKey === step.idempotencyKey) {
      try {
        input.validateOutput?.(input.schema.parse(result.output));
      } catch (error) {
        throw new InvalidCompletedScript(result, step.idempotencyKey, validationMessage(error));
      }
    }
    return result;
  });
}
