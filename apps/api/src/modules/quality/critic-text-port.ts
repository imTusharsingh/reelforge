import { ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { reservationCents, type TextPort, type TextSpec } from "@reelforge/ai-providers";
import { z } from "zod";
import type { Context, Run } from "../runs/runs.types.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import type { MediaAccounts } from "../scene-media/media-accounts.js";
import type { MediaPorts } from "../scene-media/media-ports.js";
import { MEDIA_OVERHEAD } from "../scene-media/media-prices.js";

const textResult = z.object({
  output: z.unknown(),
  providerJobId: z.string().min(1),
  usage: z.record(z.string(), z.unknown()),
});
const savedResult = z.object({ result: textResult });
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
  return reservationCents({
    currency: "USD",
    microUsd: Math.ceil(MEDIA_OVERHEAD.textMicroUsd / 3),
  });
}

/** Adapts V2 text to the existing durable V5 paid-call and run-envelope boundary. */
export function criticTextPort(deps: {
  access: MediaAccess;
  accounts: MediaAccounts;
  ports: MediaPorts;
  context: Context;
  run: Run;
  attempt: number;
}): TextPort {
  return {
    async complete<T>(
      spec: TextSpec<T>,
    ): Promise<{ output: T; providerJobId: string; usage: Record<string, unknown> }> {
      const { access, accounts, ports, context, run, attempt } = deps;
      if (!Number.isSafeInteger(attempt) || attempt < 1)
        throw new ConflictException("Invalid critic attempt");
      const key = `media:text:critic:${attempt}`;
      const fingerprint = inputFingerprint(spec);
      const db = access.runs.store.scoped(context);
      const previous = await db.videoRunStep.findFirst({
        where: { runId: run.id, key },
        orderBy: { attempt: "desc" },
      });
      if (previous) verifyInput(previous.input, fingerprint);
      if (previous?.state === "SUCCEEDED") {
        const saved = savedResult.parse(previous.output).result;
        return { ...saved, output: spec.parse(saved.output) };
      }
      if (previous?.state === "FAILED")
        throw new ConflictException("Critic provider request was rejected");
      if (
        previous &&
        !accounts.abandoned(previous) &&
        !(await accounts.recoverUndispatched(context, previous))
      ) {
        const saved = textResult.safeParse(previous.output);
        if (!saved.success || saved.data.providerJobId !== previous.providerJobId)
          return accounts.reconcilePending(context, previous);
        const result = { ...saved.data, output: spec.parse(saved.data.output) };
        await accounts.complete(context, previous, result);
        return result;
      }
      const modelId = process.env.GEMINI_TEXT_MODEL?.trim();
      if (!modelId) throw new ConflictException("Critic text model is not configured");
      const budget = await db.budgetEnvelope.findFirst({ where: { runId: run.id } });
      if (!budget) throw new ConflictException("Critic budget envelope is unavailable");
      const native = await ports.get(context);
      const cost = criticReservationCents();
      const step = await accounts.begin(context, run, key, { fingerprint }, cost, modelId);
      await accounts.prepare(context, run, step, modelId);
      const result = await accounts.dispatchText(context, step, () =>
        native.text.complete(spec, step.idempotencyKey),
      );
      await accounts.complete(context, step, result);
      return result;
    },
  };
}
