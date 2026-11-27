import type { Prisma } from "@reelforge/database";
import type { Run, Scoped, Step, Transaction } from "../runs/runs.types.js";
import { appendTextEvidence } from "../usage-budget/text-attempt-store.js";
import { prepareTextData } from "../usage-budget/text-attempt-runtime.js";

type BudgetEnvelope = Prisma.BudgetEnvelopeGetPayload<object>;
export async function prepareMediaIntent(
  tx: Transaction,
  db: Scoped,
  current: Run,
  step: Step,
  modelId: string,
  journal: boolean,
  budget: BudgetEnvelope | null,
  cost: number,
): Promise<void> {
  if (journal) {
    await appendTextEvidence(tx, step, {
      kind: "PREPARED",
      eventKey: "prepare",
      data: prepareTextData(current, step, modelId, cost),
    });
  } else if (budget)
    await db.budgetEnvelope.updateMany({
      where: { id: budget.id, revision: budget.revision },
      data: { reservedMinor: budget.reservedMinor + cost, revision: budget.revision + 1 },
    });
}
