import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import { captureShotReceipt } from "../usage-budget/run-billing.js";
import type { Step } from "../runs/runs.types.js";
import { readArtifact, readManifest } from "./historical-text-receipt.fixture.js";
import { setupAssembly } from "./media-assembly.fixture.js";

async function bookedRefusal(t: Tenant): Promise<{ step: Step; requestId: string }> {
  const { workspaceId, channelId, id: runId } = t.run;
  const providerJobId = "fixture-omitted-refusal";
  const step = await t.db.videoRunStep.create({
    data: {
      workspaceId,
      runId,
      providerId: "gemini",
      providerJobId,
      input: {},
      costMinor: 20,
      key: "shot-0",
      attempt: 2,
      state: "SKIPPED",
      idempotencyKey: randomUUID(),
      error: { code: "PROVIDER_REFUSED" },
    },
  });
  const row = await t.db.providerRequest.create({
    data: {
      workspaceId,
      channelId,
      correlationId: step.id,
      providerId: "gemini",
      capabilityId: "fixture-video",
      status: "FAILED",
      errorCode: "PROVIDER_JOB_FAILED",
      currency: "USD",
      estimatedCost: "0.20",
      responseMetadata: { providerJobId, dispatched: true },
    },
  });
  await t.db.usageReservation.create({
    data: {
      workspaceId,
      channelId,
      correlationId: step.id,
      idempotencyKey: `m08:${step.idempotencyKey}`,
      category: "VIDEO_MEDIA",
      currency: "USD",
      amountMinor: 20n,
      committedMinor: 20n,
      status: "COMMITTED",
      expiresAt: new Date(),
      committedAt: new Date(),
    },
  });
  await t.db.budgetEnvelope.updateMany({
    where: { runId },
    data: { spentMinor: { increment: 20 } },
  });
  return { step, requestId: row.id };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "assembled manifests account for terminal shot billing",
  () => {
    const fixture = runsFixture();
    afterEach(() => vi.unstubAllEnvs());
    it.each([false, true])(
      "rebuilds only the accounting descriptor, including the delivery cap: %s",
      async (aboveCap) => {
        vi.stubEnv("GEMINI_TTS_MODEL", "fixture-TTS");
        vi.stubEnv("GEMINI_MUSIC_MODEL", "fixture-music");
        const setup = await setupAssembly(fixture);
        const { t, run, bindings, plan } = setup;
        const { step, requestId } = await bookedRefusal(t);
        const prompts = [
          {
            role: "scriptwriter" as const,
            version: 2 as const,
            templateVersionId: randomUUID(),
            promptSnapshotId: randomUUID(),
            configSnapshotId: randomUUID(),
            fingerprintSha256: "a".repeat(64),
          },
        ];
        vi.mocked(bindings.planning.saved).mockResolvedValue({
          ...plan,
          manifest: { ...plan.manifest, prompts },
        });
        await t.db.videoRunStep.create({
          data: {
            workspaceId: run.workspaceId,
            runId: run.id,
            key: "ASSEMBLING",
            attempt: 1,
            state: "RUNNING",
            idempotencyKey: `${run.id}:ASSEMBLING:1`,
            input: {},
          },
        });
        const render = vi.spyOn(bindings.renderer, "render").mockResolvedValue({
          video: Buffer.from("fixture-final"),
          cover: Buffer.from("cover"),
          words: [{ text: "fixture", start: 0, end: 1 }],
          highlights: [],
          cues: [],
          duration: 30,
        });
        const bill = (costMinor: number): ReturnType<typeof captureShotReceipt> =>
          captureShotReceipt(t.store, bindings.access.paid, t.context, step, {
            costMinor,
            costBasis: "BILLED",
            modelId: "fixture",
            promptVersion: "fixture",
            seconds: 8,
            providerDurationSeconds: null,
            media: null,
          });
        const assembled = await bindings.assembly.execute(t.context, run, t.brief);
        const original = await readManifest(setup, assembled);
        const final = assembled.find((artifact) => artifact.kind === "final")!;
        await t.usage.createAdjustment(t.context, {
          kind: "CREDIT",
          amountMinor: 3,
          providerRequestId: requestId,
          operationKey: "credit-after-assembly",
          reason: "fixture refund",
        });
        await bill(aboveCap ? 801 : 25);
        const artifacts = await bindings.assembly.artifacts(t.context, run);
        expect(artifacts.find((artifact) => artifact.kind === "final")).toEqual(final);
        expect(await readArtifact(setup, final)).toEqual(Buffer.from("fixture-final"));
        if (aboveCap) {
          expect(artifacts.some((artifact) => artifact.kind === "manifest")).toBe(false);
        } else {
          const result = await readManifest(setup, artifacts);
          expect(result).toEqual({ ...original, totalCostMinor: original.totalCostMinor + 5 });
          await bill(27);
          expect(
            (await readManifest(setup, await bindings.assembly.artifacts(t.context, run)))
              .totalCostMinor,
          ).toBe(original.totalCostMinor + 7);
          await bill(27);
          expect(
            (await readManifest(setup, await bindings.assembly.artifacts(t.context, run)))
              .totalCostMinor,
          ).toBe(original.totalCostMinor + 7);
        }
        expect(render).toHaveBeenCalledOnce();
      },
    );
  },
);
