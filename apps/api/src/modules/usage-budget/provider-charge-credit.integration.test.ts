import { randomUUID } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { runsFixture } from "../runs/runs.fixture.js";
import { unresolvedLegacyCredits } from "./legacy-text-import-credits.js";

describe.skipIf(!process.env.DATABASE_URL)(
  "owner corrections to failed estimated media charges",
  () => {
    const fixture = runsFixture();
    it.each(["video", "audio"])(
      "links a %s correction once and applies it to the original charge",
      async (capabilityId) => {
        const t = await fixture.tenant();
        const { workspaceId, channelId } = t.run;
        const charge = await t.db.providerRequest.create({
          data: {
            workspaceId,
            channelId,
            correlationId: randomUUID(),
            providerId: "fixture",
            capabilityId,
            status: "FAILED",
            errorCode: "OUTAGE",
            estimatedCost: "0.20",
            currency: "USD",
          },
        });
        const input = {
          kind: "CREDIT",
          providerRequestId: charge.id,
          operationKey: "invoice-1",
          amountMinor: 13,
          reason: "provider invoice correction",
        };
        await expect(
          t.usage.createAdjustment({ ...t.context, role: "EDITOR" }, input),
        ).rejects.toBeInstanceOf(ForbiddenException);
        const result = await t.usage.createAdjustment(t.context, input);
        expect((await t.usage.createAdjustment(t.context, input)).adjustmentId).toBe(
          result.adjustmentId,
        );
        await expect(
          t.usage.createAdjustment(t.context, { ...input, operationKey: "excess", amountMinor: 8 }),
        ).rejects.toThrow("remaining");
        expect(
          await t.db.usageAdjustment.findUniqueOrThrow({ where: { id: result.adjustmentId } }),
        ).toMatchObject({
          providerRequestId: charge.id,
          textAttemptId: null,
          channelId,
          currency: "USD",
          amountMinor: 13n,
        });
        expect(
          await t.db.usageAuditRecord.findFirstOrThrow({
            where: { adjustmentId: result.adjustmentId },
          }),
        ).toMatchObject({
          actorUserId: t.context.userId,
          after: { adjustment: { providerRequestId: charge.id } },
        });
        expect(
          await t.db.$transaction((tx) => unresolvedLegacyCredits(tx, workspaceId, false)),
        ).toEqual([]);
        expect(
          (await t.usage.usageSummary(t.context, { channelId })).totals.currencies[0],
        ).toMatchObject({ failedEstimatedMinor: 7, adjustmentNetMinor: 0, totalMinor: 7 });
        expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(7);
        await t.db.providerRequest.update({
          where: { id: charge.id },
          data: { actualCost: "0.04" },
        });
        expect((await t.usage.listBudgets(t.context))[0]?.periods[0]?.consumedMinor).toBe(4);
      },
    );
  },
);
