import type { Step } from "../runs/runs.types.js";

export function remoteTextId(step: Step, reference: string | null): string | null {
  // Older workers used the local dispatch key in the remote-ID column.
  return reference && reference !== step.idempotencyKey ? reference : null;
}

export function textReceiptReference(
  step: Step,
  observedReference: string | null,
): { providerJobId: string | null; dispatchKey: string } {
  return {
    providerJobId: remoteTextId(step, observedReference) ?? remoteTextId(step, step.providerJobId),
    dispatchKey: step.idempotencyKey,
  };
}
