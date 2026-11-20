import { Inject, Injectable } from "@nestjs/common";
import {
  ProviderFailure,
  type CapabilityMetadata,
  type TextPort,
  type TextSpec,
} from "@reelforge/ai-providers";
import type { Database, WorkspaceContext } from "../../identity/identity.types.js";
import { UsageBudgetService } from "../../usage-budget/usage-budget.service.js";
import { createPendingPaidLedger, finishPaidLedger } from "../../usage-budget/paid-call.js";
import { stableKey } from "./quota.js";

@Injectable()
export class DiscoveryTextCalls {
  public constructor(
    @Inject("DATABASE") private readonly db: Database,
    private readonly budget: UsageBudgetService,
  ) {}
  public async complete<T>(
    context: WorkspaceContext,
    channelId: string,
    text: TextPort,
    spec: TextSpec<T>,
    key: string,
  ): Promise<T> {
    const { correlationId, capability, reservation } = await this.prepare(
      context,
      channelId,
      spec.prompt,
      key,
    );
    const started = Date.now();
    try {
      const result = await text.complete(spec, `m08:${key}`);
      await finishPaidLedger(this.db, {
        workspaceId: context.workspaceId,
        correlationId,
        capability,
        dispatched: true,
        actualCost: null,
        metadata: {
          providerJobId: result.providerJobId,
          usage: JSON.stringify(result.usage),
          costKnown: false,
        },
        latencyMs: Date.now() - started,
        prompt: spec.prompt,
      });
      await this.budget.finishPaidCall(reservation, { dispatched: true, actualCost: null });
      return result.output;
    } catch (error) {
      const dispatched = !(error instanceof ProviderFailure) || error.dispatched;
      await finishPaidLedger(this.db, {
        workspaceId: context.workspaceId,
        correlationId,
        capability,
        dispatched,
        actualCost: dispatched ? null : 0,
        metadata: { dispatched, costKnown: !dispatched },
        latencyMs: Date.now() - started,
        prompt: spec.prompt,
        error,
      });
      await this.budget.finishPaidCall(reservation, {
        dispatched,
        actualCost: dispatched ? null : 0,
      });
      throw error;
    }
  }
  private async prepare(
    context: WorkspaceContext,
    channelId: string,
    prompt: string,
    key: string,
  ): Promise<{
    correlationId: string;
    capability: CapabilityMetadata;
    reservation: Awaited<ReturnType<UsageBudgetService["reservePaidCall"]>>;
  }> {
    const correlationId = stableKey(key);
    // Explicit operator estimate: never invent billing data or prices.
    const estimate = Number(process.env.DISCOVERY_TEXT_ESTIMATE_USD);
    if (!Number.isFinite(estimate) || estimate <= 0)
      throw new Error("DISCOVERY_TEXT_ESTIMATE_USD must be configured");
    const capability: CapabilityMetadata = {
      providerId: "gemini",
      capabilityId: process.env.GEMINI_TEXT_MODEL ?? "",
      kind: "llm",
      input: ["text"],
      output: ["text"],
      supportsReferenceImages: false,
      asynchronous: false,
      polling: false,
      regions: [],
      costModel: { currency: "USD", unit: "request", amount: estimate },
    };
    const reservation = await this.budget.reservePaidCall({
      workspaceId: context.workspaceId,
      channelId,
      correlationId,
      category: "LLM",
      currency: "USD",
      estimate,
    });
    try {
      await createPendingPaidLedger(this.db, {
        workspaceId: context.workspaceId,
        channelId,
        correlationId,
        capability,
        prompt,
      });
    } catch (error) {
      await this.budget.finishPaidCall(reservation, { dispatched: false, actualCost: null });
      throw error;
    }
    return { correlationId, capability, reservation };
  }
}
