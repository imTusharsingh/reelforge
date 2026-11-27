import {
  GeminiText,
  Interactions,
  ProviderHttp,
  type PaidTextTransport,
} from "@reelforge/ai-providers";
import { Prisma } from "@reelforge/database";
import { vi } from "vitest";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import type { PaidTextInvocation } from "../usage-budget/text-attempt-runtime.js";
import type { Step, Transaction } from "./runs.types.js";
import type { Tenant, runsFixture } from "./runs.fixture.js";

const narrator = {
  providerId: "gemini" as const,
  voiceId: "fixture-voice",
  language: "English",
  pace: 1,
};
const model = "fixture-text";
const estimate = 7;
const draft = { draft: "fixture" };

export async function runtimeFixture(fixture: ReturnType<typeof runsFixture>): Promise<{
  t: Tenant;
  accounts: ReturnType<typeof bindMedia>["accounts"];
  step: Step;
}> {
  const t = await fixture.tenant("L2", 30, narrator);
  await t.engine.process(t.runs.job(t.context, t.run.id));
  const run = await t.store.get(t.context, t.run.id);
  await t.db.budgetEnvelope.create({
    data: {
      workspaceId: t.context.workspaceId,
      runId: run.id,
      currency: "USD",
      baseEstimateMinor: 200,
      reshootReserveMinor: 100,
      hardCapMinor: 800,
      route: "PRIMARY",
    },
  });
  const native = fakeMediaPorts(
    t.context.workspaceId,
    t.storage,
    { clip: Buffer.alloc(0), image: Buffer.alloc(0), audio: Buffer.alloc(0) },
    [],
  );
  const { accounts } = bindMedia(t, native);
  vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
  const step = await accounts.begin(
    t.context,
    run,
    "media:text:scriptwriter",
    {},
    estimate,
    model,
    true,
  );
  return { t, accounts, step };
}

export function invocation(step: Step, transport: PaidTextTransport): PaidTextInvocation<unknown> {
  const http = new ProviderHttp("AIza" + "abc".repeat(12), "gemini", undefined, 10_000, transport);
  const port = new GeminiText(
    new Interactions(http, {
      save: async (): Promise<never> => {
        throw new Error("Unexpected text receipt artifact");
      },
    }),
    model,
  );
  return (onSent) =>
    port.completePaid(
      { prompt: "fixture", jsonSchema: {}, parse: (value): unknown => value },
      step.idempotencyKey,
      onSent,
    );
}

export function accepted(): PaidTextTransport {
  return async (_url, _request, onSent) => {
    await onSent();
    return Response.json({
      status: "completed",
      usage: { input_tokens: 12, output_tokens: 3 },
      steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(draft) }] }],
    });
  };
}

export function rejected401(): PaidTextTransport {
  return async (_url, _request, onSent) => {
    await onSent();
    return Response.json(
      { error: { code: 401, status: "UNAUTHENTICATED", message: "fixture" } },
      { status: 401 },
    );
  };
}

export function socketReset(): PaidTextTransport {
  return async (_url, _request, onSent) => {
    await onSent();
    throw new Error("socket reset after handoff");
  };
}

export function snapshot(
  t: Tenant,
  step: Step,
): Promise<{
  journal: Awaited<ReturnType<Tenant["db"]["textAttemptEvidence"]["findMany"]>>;
  projection: Awaited<ReturnType<Tenant["db"]["textAttemptProjection"]["findFirst"]>>;
  reservations: Awaited<ReturnType<Tenant["db"]["usageReservation"]["findMany"]>>;
  budget: Awaited<ReturnType<Tenant["db"]["budgetEnvelope"]["findFirstOrThrow"]>>;
}> {
  const { workspaceId, runId, id } = step;
  const where = { workspaceId, attemptId: id };
  return Promise.all([
    t.db.textAttemptEvidence.findMany({ where, orderBy: { sequence: "asc" } }),
    t.db.textAttemptProjection.findFirst({ where }),
    t.db.usageReservation.findMany({ where: { workspaceId, correlationId: id } }),
    t.db.budgetEnvelope.findFirstOrThrow({ where: { workspaceId, runId } }),
  ]).then(([journal, projection, reservations, budget]) => ({
    journal,
    projection,
    reservations,
    budget,
  }));
}

export async function putLateRejection(t: Tenant, step: Step): Promise<void> {
  const arm = await t.db.textAttemptEvidence.findFirstOrThrow({
    where: { workspaceId: step.workspaceId, attemptId: step.id, kind: "ARMED" },
  });
  if (!arm.nonce) throw new Error("Expected sender nonce");
  await t.artifacts.writeTextSpool(
    t.context,
    `runs/text-evidence/${step.id}/${arm.nonce}/REJECTED.json`,
    Buffer.from(
      JSON.stringify({
        kind: "REJECTED",
        data: { dispatchKey: step.idempotencyKey, code: "UNAUTHENTICATED", httpStatus: 401 },
      }),
    ),
  );
}

// Injection occurs only when a rejection was present before the callback and
// the callback tries to advance the settlement projection past it.
export function timeOutRejectionFold(
  t: Tenant,
  step: Step,
): {
  restore: () => void;
  aborted: () => number;
} {
  const transaction = t.db.$transaction.bind(t.db);
  const where = { workspaceId: step.workspaceId, attemptId: step.id };
  let aborted = 0;
  const wrap = async (work: (tx: Transaction) => Promise<unknown>): Promise<unknown> =>
    transaction(async (tx) => {
      const rejection = await tx.textAttemptEvidence.findFirst({
        where: { ...where, kind: "REJECTED" },
      });
      const result = await work(tx);
      if (rejection) {
        const applied = await tx.textAttemptProjection.findFirst({ where });
        if ((applied?.appliedSequence ?? 0) >= rejection.sequence) {
          aborted++;
          throw new Prisma.PrismaClientKnownRequestError(
            "Interactive transaction expired before commit",
            { code: "P2028", clientVersion: "fixture" },
          );
        }
      }
      return result;
    });
  const spy = vi.spyOn(t.db, "$transaction").mockImplementation(wrap as typeof t.db.$transaction);
  return { restore: () => spy.mockRestore(), aborted: () => aborted };
}
