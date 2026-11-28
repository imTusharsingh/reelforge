import { QualityRubricSchema } from "@reelforge/contracts";
import { ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { type TextPort, type TextSpec } from "@reelforge/ai-providers";
import { z } from "zod";
import type { Context, Run } from "../runs/runs.types.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaAccounts } from "../scene-media/media-accounts.js";
import type { MediaPorts } from "../scene-media/media-ports.js";
import { textCallCents } from "../scene-media/media-prices.js";

import { attachedTextResult, textResultSchema } from "../usage-budget/run-admission-state.js";

const savedResult = z.object({ result: textResultSchema });
function inputFingerprint<T>(spec: TextSpec<T>): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        prompt: spec.prompt,
        systemPrompt: spec.systemPrompt,
        media: spec.media,
        grounding: spec.grounding,
        jsonSchema: spec.jsonSchema,
      }),
    )
    .digest("hex");
}

function verifyInput(input: unknown, fingerprint: string): void {
  const saved = z.object({ spec: z.object({ fingerprint: z.string() }) }).safeParse(input);
  if (!saved.success || saved.data.spec.fingerprint !== fingerprint)
    throw new ConflictException("Critic attempt input changed");
}

export function criticReservationCents(): number {
  return textCallCents();
}

type CriticDependencies = {
  access: MediaAccess;
  accounts: MediaAccounts;
  ports: MediaPorts;
  context: Context;
  run: Run;
  attempt: number;
};

async function drainEarlierReviews(
  { access, accounts, context, run }: CriticDependencies,
  key: string,
): Promise<void> {
  const steps = await access.runs.store.scoped(context).videoRunStep.findMany({
    where: {
      runId: run.id,
      key: { startsWith: "media:text:critic:", not: key },
      state: { in: ["RUNNING", "WAITING_EXTERNAL"] },
    },
  });
  for (const step of steps) {
    if (await accounts.recoverUndispatched(context, step)) continue;
    const saved = attachedTextResult(step);
    if (!saved || !QualityRubricSchema.safeParse(saved.output).success)
      await accounts.reconcilePending(context, step);
    else await accounts.complete(context, step, saved);
  }
}

/** Adapts V2 text to the existing durable V5 paid-call and run-envelope boundary. */
export function criticTextPort(deps: CriticDependencies): TextPort {
  return {
    async complete<T>(
      spec: TextSpec<T>,
    ): Promise<{ output: T; providerJobId: string; usage: Record<string, unknown> }> {
      const { access, accounts, context, run, attempt } = deps;
      if (!Number.isSafeInteger(attempt) || attempt < 1)
        throw new ConflictException("Invalid critic attempt");
      const key = `media:text:critic:${attempt}`;
      const fingerprint = inputFingerprint(spec);
      const db = access.runs.store.scoped(context);
      if (attempt > 1) await drainEarlierReviews(deps, key);
      const previous = await db.videoRunStep.findFirst({
        where: { runId: run.id, key },
        orderBy: { attempt: "desc" },
      });
      if (previous) verifyInput(previous.input, fingerprint);
      if (previous?.state === "SUCCEEDED") {
        const saved = savedResult.parse(previous.output).result;
        return {
          ...saved,
          providerJobId: saved.providerJobId ?? "",
          output: spec.parse(saved.output),
        };
      }
      if (previous?.state === "FAILED")
        throw new ConflictException("Critic provider request was rejected");
      if (
        previous &&
        !accounts.abandoned(previous) &&
        !(await accounts.recoverUndispatched(context, previous))
      ) {
        const saved = attachedTextResult(previous);
        if (!saved) return accounts.reconcilePending(context, previous);
        const result = { ...saved, output: spec.parse(saved.output) };
        await accounts.complete(context, previous, result);
        return { ...result, providerJobId: result.providerJobId ?? "" };
      }
      return submitCritic(deps, key, fingerprint, spec);
    },
  };
}

async function submitCritic<T>(
  { access, accounts, ports, context, run, attempt }: CriticDependencies,
  key: string,
  fingerprint: string,
  spec: TextSpec<T>,
): Promise<{ output: T; providerJobId: string; usage: Record<string, unknown> }> {
  const db = access.runs.store.scoped(context);
  const modelId = process.env.GEMINI_TEXT_MODEL?.trim();
  if (!modelId) throw new ConflictException("Critic text model is not configured");
  const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
  if (!budget) throw new ConflictException("Critic budget envelope is unavailable");
  const native = await ports.get(context);
  const cost = criticReservationCents();
  const step = await accounts.begin(
    context,
    run,
    key,
    { fingerprint, assemblyRevision: attempt },
    cost,
    modelId,
    true,
  );
  const paid = native.text.completePaid?.bind(native.text);
  if (!paid) throw new ConflictException("Paid text transport is unavailable");
  const result = await accounts.dispatchTextAttempt(context, step, (sent) =>
    paid(spec, step.idempotencyKey, sent),
  );
  await accounts.complete(context, step, result);
  return { ...result, providerJobId: result.providerJobId ?? "" };
}
