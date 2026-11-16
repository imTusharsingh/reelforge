import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HookSchema } from "@reelforge/contracts";
import type { WorkspaceContext } from "../identity/identity.types.js";
import { type PaidCallReservation } from "../usage-budget/usage-budget.types.js";
import { resolveScriptGenre } from "./script-genre.js";
import {
  parseScriptWriteDocument,
  validateGenrePolicy,
  validateScript,
} from "./script.validation.js";
import { ScriptOperations } from "./script-operations.js";
import {
  generateSchema,
  providerEnvelopeSchema,
  provenanceSchema,
  promptBundleSchema,
  type Reservation,
} from "./script-generation.types.js";
@Injectable()
export class ScriptService extends ScriptOperations {
  public async generate(context: WorkspaceContext, body: unknown): Promise<unknown> {
    this.editor(context);
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const snapshot = await this.db.ideaApprovalSnapshot.findUnique({
      where: {
        workspaceId_id: { workspaceId: context.workspaceId, id: input.approvedIdeaSnapshotId },
      },
      include: { idea: { select: { status: true } } },
    });
    if (
      !snapshot ||
      snapshot.idea.status !== "APPROVED" ||
      snapshot.checksumSha256 !== input.approvedIdeaChecksum ||
      (input.channelId !== undefined && snapshot.channelId !== input.channelId)
    ) {
      throw new ConflictException(
        "Approved idea snapshot is missing, foreign, stale, or not approved",
      );
    }
    if (!HookSchema.safeParse(snapshot.hook).success)
      throw new BadRequestException("Approved idea hook must contain 1–20 words");
    const [config, prompt] = await Promise.all([
      this.db.configSnapshot.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: input.configSnapshotId } },
        select: { id: true, config: true },
      }),
      this.db.promptBundleSnapshot.findUnique({
        where: { workspaceId_id: { workspaceId: context.workspaceId, id: input.promptSnapshotId } },
        select: { id: true, configSnapshotId: true, bundle: true, fingerprintSha256: true },
      }),
    ]);
    const bundle = promptBundleSchema.safeParse(prompt?.bundle);
    if (!config || !prompt || prompt.configSnapshotId !== config.id || !bundle.success) {
      throw new ConflictException(
        "Configuration and prompt snapshots must be an owned, valid pair",
      );
    }
    if (bundle.data.fingerprintSha256 !== prompt.fingerprintSha256) {
      throw new ConflictException("Prompt snapshot fingerprint does not match its content");
    }
    this.registry.assertReady(
      this.llm.capability,
      process.env.NODE_ENV === "production" ? "production" : "development",
    );
    const estimate = this.llm.capability.costModel.amount;
    if (estimate === null) {
      throw new ConflictException("Provider cost is unknown; budget preflight cannot dispatch");
    }
    const estimationCurrency = this.llm.capability.costModel.currency;
    const correlationId = input.correlationId ?? randomUUID();

    const started = Date.now();
    const dispatchedPrompt = [
      bundle.data.renderedText,
      `Configuration: ${JSON.stringify(config.config)}`,
      `Additional instructions: ${input.prompt}`,
      `Approved idea snapshot: ${snapshot.topic}`,
      snapshot.hook,
      snapshot.angle,
    ].join("\n");
    // M18 preflight (B1), before the M08 ledger row exists so the call is not counted twice: a hard
    // stop (BUDGET_EXHAUSTED / unresolvable, 409) throws here and the provider is never called.
    // NOT_CONFIGURED (null) proceeds under the M16 manual-run rule.
    const usageHold: PaidCallReservation | null =
      this.usage === undefined
        ? null
        : await this.usage.reservePaidCall({
            workspaceId: context.workspaceId,
            channelId: input.channelId ?? null,
            correlationId,
            category: "LLM",
            currency: estimationCurrency,
            estimate,
          });
    let reservation: Reservation;
    try {
      reservation = await this.reserveBudget(
        context.workspaceId,
        input.channelId ?? null,
        estimate,
        correlationId,
        dispatchedPrompt,
      );
    } catch (error) {
      // The M08 guard refused: the provider was never called, so the M18 hold is released.
      await this.usage?.finishPaidCall(usageHold, { dispatched: false, actualCost: null });
      throw error;
    }
    let result: z.infer<typeof providerEnvelopeSchema> | undefined;
    let settled = false;
    let dispatched = false;
    let usageFinished = false;
    try {
      dispatched = true;
      const envelope = providerEnvelopeSchema.safeParse(
        await this.llm.complete({ prompt: dispatchedPrompt, correlationId }),
      );
      if (!envelope.success) throw new ConflictException("Provider returned an invalid envelope");
      result = envelope.data;
      const provenance = provenanceSchema.safeParse(result.metadata);
      await this.settleBudget(
        context.workspaceId,
        reservation,
        provenance.success ? provenance.data.cost : null,
        estimate,
      );
      settled = true;
      usageFinished = true;
      await this.usage?.finishPaidCall(usageHold, {
        dispatched: true,
        actualCost: provenance.success ? provenance.data.cost : null,
        actualCurrency: provenance.success ? (provenance.data.currency ?? null) : null,
      });
      if (!provenance.success) throw new ConflictException("Provider returned invalid provenance");
      const document = parseScriptWriteDocument(result.output);
      validateScript(document);
      const genre = await resolveScriptGenre(this.db, context.workspaceId, document.metadata.genre);
      validateGenrePolicy(document, genre, snapshot.references);
      const created = await this.db.$transaction(async (tx) => {
        const script = await tx.script.create({
          data: {
            workspaceId: context.workspaceId,
            approvedIdeaSnapshotId: snapshot.id,
            ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
            approvedIdeaChecksum: snapshot.checksumSha256,
            createdByUserId: context.userId,
          },
        });
        await tx.scriptRevision.create({
          data: {
            workspaceId: context.workspaceId,
            scriptId: script.id,
            revision: 1,
            document,
            promptVersion: provenance.data.promptVersion,
            modelVersion: provenance.data.modelVersion,
            cost: provenance.data.cost,
            costCurrency: provenance.data.currency ?? null,
            configSnapshotId: config.id,
            promptSnapshotId: prompt.id,
            promptText: dispatchedPrompt,
            createdByUserId: context.userId,
          },
        });
        return script;
      });
      await this.recordRequest({
        context,
        channelId: input.channelId ?? null,
        correlationId,
        estimate,
        estimationCurrency,
        dispatchedPrompt,
        latencyMs: Date.now() - started,
        result,
        response: this.providerResponse(result),
      });
      return this.get(context, created.id);
    } catch (error) {
      await this.recordRequest({
        context,
        channelId: input.channelId ?? null,
        correlationId,
        estimate,
        estimationCurrency,
        dispatchedPrompt,
        latencyMs: Date.now() - started,
        ...(result === undefined ? {} : { result }),
        response: this.providerResponse(result),
        error,
      });
      throw error;
    } finally {
      if (!settled) {
        await this.releaseBudget(context.workspaceId, reservation);
      }
      // A dispatched call that failed is charged at its estimate (the provider may have billed it);
      // only a call that never reached the provider is released.
      if (!usageFinished)
        await this.usage?.finishPaidCall(usageHold, { dispatched, actualCost: null });
    }
  }
}
