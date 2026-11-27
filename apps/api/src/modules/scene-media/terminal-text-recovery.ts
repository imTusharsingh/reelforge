import type { Prisma } from "@reelforge/database";
import type { RunsStore } from "../runs/runs.store.js";
import type { Context, Step } from "../runs/runs.types.js";
import { SessionLockBusy } from "../runs/session-lock.js";
import { attachedTextResult } from "../usage-budget/run-admission-state.js";
import { withTextDispatch } from "../usage-budget/text-dispatch-recovery.js";
import type { MediaAccounts } from "./media-accounts.js";

const terminalTextWhere = {
  key: { startsWith: "media:text:" },
  state: "WAITING_EXTERNAL",
  run: { state: { in: ["CANCELED", "FAILED", "PUBLISHED", "LEARNING"] } },
} satisfies Prisma.VideoRunStepWhereInput;

/** Terminal stages cannot replay their handlers; they can still settle a stored completed receipt. */
export async function drainTerminalTextReceipts(
  store: RunsStore,
  accounts: Pick<MediaAccounts, "complete">,
  context: Context,
): Promise<void> {
  const db = store.scoped(context);
  const steps = await db.videoRunStep.findMany({ where: terminalTextWhere });
  for (const step of steps) {
    if (attachedTextResult(step)) await drainReceipt(store, accounts, context, step);
  }
}

async function drainReceipt(
  store: RunsStore,
  accounts: Pick<MediaAccounts, "complete">,
  context: Context,
  step: Step,
): Promise<void> {
  try {
    // Let an attaching worker finish and serialize multiple recovery sweeps.
    await withTextDispatch(step, async () => {
      const current = await store.scoped(context).videoRunStep.findFirst({
        where: { ...terminalTextWhere, id: step.id },
      });
      const result = current && attachedTextResult(current);
      // Do not rebuild planning artifacts or call a provider. The output is already durable.
      if (current && result) await accounts.complete(context, current, result);
    });
  } catch (error) {
    if (!(error instanceof SessionLockBusy)) throw error;
  }
}
