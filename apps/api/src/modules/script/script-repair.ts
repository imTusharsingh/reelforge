import { InvalidCompletedText } from "@reelforge/ai-providers";
import { z } from "zod";
import type { Step } from "../runs/runs.types.js";

export const scriptwriterKey = "media:text:scriptwriter";
const validationFailure = z.object({
  code: z.literal("SCRIPT_VALIDATION"),
  message: z.string().min(1),
});
const repairSpec = z.object({ repairOf: z.uuid() });
export const isScriptRepair = (step: Step): boolean =>
  z.object({ spec: repairSpec }).safeParse(step.input).success;

export function failedScriptValidation(step: Step): string | undefined {
  if (step.state !== "FAILED" || step.key !== scriptwriterKey) return;
  return validationFailure.safeParse(step.error).data?.message;
}

export function repairMessage(step: Step): string | undefined {
  if (!isScriptRepair(step)) return failedScriptValidation(step);
}

export function authorizesScriptRepair(step: Step, spec: unknown): boolean {
  return !!repairMessage(step) && repairSpec.safeParse(spec).data?.repairOf === step.id;
}

export function validationMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (issue) return `${issue.path.join(".") || "script"}: ${issue.message}`.slice(0, 512);
  }
  return error instanceof Error ? error.message.slice(0, 512) : "Invalid script output";
}

export class InvalidCompletedScript extends InvalidCompletedText {
  public constructor(
    completion: Pick<InvalidCompletedText, "usage" | "providerJobId">,
    dispatchKey: string,
    public readonly validationError: string,
  ) {
    super(completion.providerJobId, completion.usage, dispatchKey);
    this.message = validationError;
  }
}
