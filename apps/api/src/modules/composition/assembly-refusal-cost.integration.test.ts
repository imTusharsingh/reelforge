import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import { captureShotReceipt } from "../usage-budget/run-billing.js";
import type { Step } from "../runs/runs.types.js";
import {
  historicalTextFixture,
  importHistoricalBooking,
  readArtifact,
  readManifest,
} from "./historical-text-receipt.fixture.js";
import { setupAssembly } from "./media-assembly.fixture.js";

async function bookedRefusal(t: Tenant, attempt = 2): Promise<{ step: Step; requestId: string }> {
  const { workspaceId, channelId, id: runId } = t.run;
  const providerJobId = `fixture-omitted-refusal-${attempt}`;
  const step = await t.db.videoRunStep.create({
    data: {
      workspaceId,
      runId,
      providerId: "gemini",
      providerJobId,
      input: {},
      costMinor: 20,
      key: "shot-0",
      attempt,
      state: "SKIPPED",
      finishedAt: new Date(),
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
  await t.store.mutate(t.context, runId, "shot_refused", async () => ({
    value: null,
    payload: {},
    stepId: step.id,
  }));
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
        const text = aboveCap ? await historicalTextFixture(setup, "id-less") : null;
        if (text) {
          await t.db.budgetEnvelope.updateMany({
            where: { runId: run.id },
            data: { spentMinor: { increment: 7 } },
          });
          await importHistoricalBooking(t, text.dispatchKey);
        }
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
        await bill(aboveCap ? 20 + 801 - original.totalCostMinor : 25);
        const artifacts = await bindings.assembly.artifacts(t.context, run);
        expect(artifacts.find((artifact) => artifact.kind === "final")).toEqual(final);
        expect(await readArtifact(setup, final)).toEqual(Buffer.from("fixture-final"));
        if (aboveCap) {
          expect(artifacts.some((artifact) => artifact.kind === "manifest")).toBe(false);
          const textStep = await t.db.videoRunStep.findFirstOrThrow({
            where: { runId: run.id, idempotencyKey: text!.dispatchKey },
          });
          vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
          await t.usage.createAdjustment(t.context, {
            kind: "CREDIT",
            amountMinor: 2,
            textAttemptId: textStep.id,
            operationKey: "text-credit-below-cap",
            reason: "fixture text adjustment",
          });
          const restored = await bindings.assembly.artifacts(t.context, run);
          expect(restored.find((artifact) => artifact.kind === "final")).toEqual(final);
          const manifest = await readManifest(setup, restored);
          expect(manifest.totalCostMinor).toBe(799);
          expect(
            manifest.receipts.find((line) => line.dispatchKey === text!.dispatchKey)
              ?.postedNetMinor,
          ).toBe(5);
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
describe.skipIf(!process.env.DATABASE_URL)("archive isolation across distinct renders", () => {
  const fixture = runsFixture();
  afterEach(() => vi.unstubAllEnvs());
  it.each(["healthy", "legacy", "missing", "corrupt", "temporary", "slow"] as const)(
    "isolates older renders and archive storage failures: %s",
    async (condition) => {
      vi.stubEnv("GEMINI_TTS_MODEL", "fixture-TTS");
      vi.stubEnv("GEMINI_MUSIC_MODEL", "fixture-music");
      const setup = await setupAssembly(fixture);
      const { t, run, bindings, plan } = setup;
      vi.mocked(bindings.planning.saved).mockResolvedValue({
        ...plan,
        manifest: {
          ...plan.manifest,
          prompts: [
            {
              role: "scriptwriter",
              version: 2,
              templateVersionId: randomUUID(),
              promptSnapshotId: randomUUID(),
              configSnapshotId: randomUUID(),
              fingerprintSha256: "a".repeat(64),
            },
          ],
        },
      });
      await t.db.videoRunStep.create({
        data: {
          workspaceId: run.workspaceId,
          runId: run.id,
          key: "ASSEMBLING",
          state: "RUNNING",
          attempt: 1,
          idempotencyKey: `${run.id}:ASSEMBLING:1`,
          input: {},
        },
      });
      vi.spyOn(bindings.renderer, "render").mockResolvedValue({
        video: Buffer.from("render-one"),
        cover: Buffer.from("cover"),
        words: [{ text: "fixture", start: 0, end: 1 }],
        highlights: [],
        cues: [],
        duration: 30,
      });
      const { step: shared } = await bookedRefusal(t);
      const first = await bindings.assembly.execute(t.context, run, t.brief);
      const original = await readManifest(setup, first);
      const snapshot = await t.db.videoRunStep.findFirstOrThrow({
        where: { runId: run.id, key: "local:assembly" },
      });
      await t.db.videoRunStep.update({
        where: { id: snapshot.id },
        data: {
          key: `quality:assembly-history:${snapshot.id}`,
          idempotencyKey: randomUUID(),
          ...(condition === "legacy" && { output: { storageArtifacts: first } }),
        },
      });
      const { step } = await bookedRefusal(t, 3);
      vi.mocked(bindings.renderer.render).mockResolvedValue({
        video: Buffer.from("render-two"),
        cover: Buffer.from("cover"),
        words: [{ text: "fixture", start: 0, end: 1 }],
        highlights: [],
        cues: [],
        duration: 30,
      });
      const second = await bindings.assembly.execute(t.context, run, t.brief);
      const beforeBill = await readManifest(setup, second);
      const oldManifest = first.find((item) => item.kind === "manifest")!;
      const oldKey = { workspaceId: run.workspaceId, objectKey: oldManifest.objectKey };
      if (condition === "missing") await t.storage.deleteObject(oldKey);
      if (condition === "corrupt")
        await t.storage.putObject({
          ...oldKey,
          body: Buffer.from("corrupt"),
          contentType: "application/json",
        });
      const slowStarted = Promise.withResolvers<void>();
      const releaseSlow = Promise.withResolvers<void>();
      let holdOld = condition === "slow";
      const get = t.storage.getObject.bind(t.storage);
      const flaky = vi.spyOn(t.storage, "getObject").mockImplementation(async (input) => {
        if (condition === "temporary" && input.objectKey === oldKey.objectKey)
          throw new Error("temporary storage failure");
        if (holdOld && input.objectKey === oldKey.objectKey) {
          slowStarted.resolve();
          await releaseSlow.promise;
        }
        return get(input);
      });
      for (const [attempt, costMinor] of [
        [shared, 23],
        [step, 25],
      ] as const)
        await captureShotReceipt(t.store, bindings.access.paid, t.context, attempt, {
          costMinor,
          costBasis: "BILLED",
          modelId: "fixture",
          promptVersion: "fixture",
          seconds: 8,
          providerDurationSeconds: null,
          media: null,
        });
      const detail = t.runs.detail(t.context, run.id);
      if (condition === "slow") {
        try {
          await slowStarted.promise;
          const live = (): Promise<Step> =>
            t.db.videoRunStep.findFirstOrThrow({ where: { runId: run.id, key: "local:assembly" } });
          // The sibling publishes while the archived object is still blocked.
          await expect
            .poll(
              async () =>
                t.artifacts.descriptors((await live()).output).find((a) => a.kind === "manifest")
                  ?.objectKey,
            )
            .toBeTypeOf("string");
          // A newer bill can acquire the run lock, and supersedes the in-flight rewrite.
          await captureShotReceipt(t.store, bindings.access.paid, t.context, shared, {
            costMinor: 24,
            costBasis: "BILLED",
            modelId: "fixture",
            promptVersion: "fixture",
            seconds: 8,
            providerDurationSeconds: null,
            media: null,
          });
        } finally {
          holdOld = false;
          releaseSlow.resolve();
        }
      }
      await expect(detail).resolves.toBeDefined();
      if (condition === "slow") {
        const older = await t.db.videoRunStep.findUniqueOrThrow({ where: { id: snapshot.id } });
        expect(t.artifacts.descriptors(older.output).some((a) => a.kind === "manifest")).toBe(
          false,
        );
      }
      const active = await bindings.assembly.artifacts(t.context, run);
      expect(await readManifest(setup, active)).toEqual({
        ...beforeBill,
        totalCostMinor: beforeBill.totalCostMinor + (condition === "slow" ? 9 : 8),
      });
      expect(active.find((item) => item.kind === "final")).toEqual(
        second.find((item) => item.kind === "final"),
      );
      const archive = (): Promise<Step> =>
        t.db.videoRunStep.findUniqueOrThrow({ where: { id: snapshot.id } });
      flaky.mockRestore();
      if (condition === "temporary") await t.runs.detail(t.context, run.id);
      const stored = (await archive()).output;
      if (condition !== "missing" && condition !== "corrupt") {
        expect(await readManifest(setup, t.artifacts.descriptors(stored))).toEqual({
          ...original,
          totalCostMinor: original.totalCostMinor + (condition === "slow" ? 4 : 3),
        });
      } else {
        expect(stored).toMatchObject({ manifestArchiveInvalid: true });
        expect(t.artifacts.descriptors(stored).some((item) => item.kind === "manifest")).toBe(
          false,
        );
      }
    },
  );
});
