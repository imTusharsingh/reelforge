import { randomUUID } from "node:crypto";
import { compilePrompt, parsePromptTemplateBody, platformDefaults } from "@reelforge/config-engine";
import { ProviderRegistry } from "@reelforge/ai-providers";
import { createDatabaseClient } from "@reelforge/database";
import { afterAll, describe, expect, it } from "vitest";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { ScriptService } from "../script/script.service.js";
import type { ScriptLlmPort } from "../script/script.types.js";
import { UsageBudgetService } from "./usage-budget.service.js";
import { BudgetExhaustedError } from "./usage-budget.types.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);

const document = {
  schemaVersion: "1.0" as const,
  title: "T",
  hook: "H",
  dialogue: "D",
  cta: "C",
  metadata: { genre: "M18 genre", targetDurationSeconds: 1, factual: false },
  scenes: [
    {
      id: "one",
      startSeconds: 0,
      durationSeconds: 1,
      characterRefs: [],
      dialogue: "D",
      visualDescription: "V",
      camera: "wide",
      audioCues: [],
    },
  ],
};

/** Fixture LLM priced at 1 USD (100 minor) per call that counts real dispatches. */
function countingLlm(
  behaviour: Readonly<{ delayMs?: number; fail?: boolean; cost?: number | null }> = {},
): ScriptLlmPort & { calls: number } {
  const llm = {
    calls: 0,
    capability: {
      providerId: "fixture",
      capabilityId: "llm",
      kind: "llm" as const,
      input: ["text" as const],
      output: ["json" as const],
      supportsReferenceImages: false,
      asynchronous: false,
      polling: false,
      regions: [],
      costModel: { currency: "USD", unit: "request" as const, amount: 1 },
    },
    complete: async (): Promise<unknown> => {
      llm.calls += 1;
      if (behaviour.delayMs !== undefined)
        await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      if (behaviour.fail === true) throw new Error("provider timed out after dispatch");
      return {
        output: document,
        metadata: {
          modelVersion: "fixture-model",
          promptVersion: "fixture-prompt",
          cost: behaviour.cost === undefined ? 1 : behaviour.cost,
          currency: "USD",
        },
      };
    },
  };
  return llm as unknown as ScriptLlmPort & { calls: number };
}

suite("M18 preflight on M08 paid script calls (B1)", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  const workspaces: string[] = [];
  const users: string[] = [];

  afterAll(async () => {
    if (!db) return;
    for (const workspaceId of workspaces) {
      await db.scriptRevision.deleteMany({ where: { workspaceId } });
      await db.script.deleteMany({ where: { workspaceId } });
      await db.promptBundleSnapshot.deleteMany({ where: { workspaceId } });
      await db.configSnapshot.deleteMany({ where: { workspaceId } });
      await db.ideaApprovalSnapshot.deleteMany({ where: { workspaceId } });
      await db.idea.deleteMany({ where: { workspaceId } });
    }
    await db.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });

  async function fixture(llm: ScriptLlmPort): Promise<{
    owner: WorkspaceContext;
    workspaceId: string;
    channelId: string;
    script: ScriptService;
    usage: UsageBudgetService;
    body: (prompt: string) => Record<string, string>;
  }> {
    if (!db) throw new Error("database unavailable");
    const [ownerId, workspaceId, channelId, ideaId, snapshotId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const [configSnapshotId, promptSnapshotId, templateId, templateVersionId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    users.push(ownerId);
    workspaces.push(workspaceId);
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@m18-m08.invalid` } });
    await db.workspace.create({ data: { id: workspaceId, name: "m18-m08" } });
    await db.workspaceMembership.create({ data: { workspaceId, userId: ownerId, role: "OWNER" } });
    await db.channel.create({ data: { id: channelId, workspaceId, name: "m18-m08" } });
    await db.genre.create({
      data: {
        workspaceId,
        name: "M18 genre",
        audience: "all",
        tone: "plain",
        topicsAllowed: [],
        topicsBlocked: [],
        language: "en",
        structure: {},
        durationPreference: {},
        safetyProfile: { requiresSourceBackedClaims: false },
      },
    });
    const idea = {
      topic: "topic",
      hook: "hook",
      angle: "angle",
      audience: "all",
      references: [],
      sourceNotes: null,
      expectedFormat: "short",
    };
    await db.idea.create({
      data: {
        ...idea,
        id: ideaId,
        workspaceId,
        channelId,
        origin: "USER",
        status: "APPROVED",
        title: "Approved",
        normalizedTitle: "approved",
        approvedAt: new Date(),
        createdByUserId: ownerId,
      },
    });
    await db.ideaApprovalSnapshot.create({
      data: { ...idea, id: snapshotId, workspaceId, ideaId, channelId, checksumSha256: "checksum" },
    });
    const templateBody = parsePromptTemplateBody({
      sections: { instructions: "Write a structured script for {{topic}}." },
      variables: [{ name: "topic", required: true }],
      allowedAdditionSections: ["instructions"],
    });
    const bundle = compilePrompt({
      config: platformDefaults,
      template: {
        templateId,
        templateKey: "m18-script",
        templateName: "M18 script",
        versionId: templateVersionId,
        version: 1,
        checksumSha256: "a".repeat(64),
        body: templateBody,
      },
      variables: { topic: "approved topic" },
    });
    await db.promptTemplate.create({
      data: { id: templateId, workspaceId, key: "m18-script", name: "M18 script" },
    });
    await db.promptTemplateVersion.create({
      data: {
        id: templateVersionId,
        workspaceId,
        templateId,
        version: 1,
        status: "PUBLISHED",
        body: templateBody,
        checksumSha256: "a".repeat(64),
      },
    });
    await db.configSnapshot.create({
      data: {
        id: configSnapshotId,
        workspaceId,
        version: 1,
        config: platformDefaults,
        fingerprintSha256: "b".repeat(64),
        resolutionSha256: "c".repeat(64),
        layers: [],
        lockedFields: [],
      },
    });
    await db.promptBundleSnapshot.create({
      data: {
        id: promptSnapshotId,
        workspaceId,
        version: 1,
        configSnapshotId,
        templateId,
        templateVersionId,
        bundle,
        fingerprintSha256: bundle.fingerprintSha256,
      },
    });
    // The M08 daily guard is generous so only the M18 budget can refuse.
    await db.providerBudget.create({
      data: { workspaceId, channelId, dailyLimit: 1000, currency: "USD" },
    });
    const registry = new ProviderRegistry();
    registry.register({
      capability: llm.capability,
      credential: {
        providerId: "fixture",
        environment: process.env.NODE_ENV === "production" ? "production" : "development",
        secret: "fixture-secret",
      },
    });
    const usage = new UsageBudgetService(db as never, () => new Date());
    const script = new ScriptService(db as Database, llm, registry, undefined, usage);
    return {
      owner: { workspaceId, userId: ownerId, role: "OWNER" },
      workspaceId,
      channelId,
      script,
      usage,
      body: (prompt) => ({
        approvedIdeaSnapshotId: snapshotId,
        approvedIdeaChecksum: "checksum",
        prompt,
        channelId,
        configSnapshotId,
        promptSnapshotId,
      }),
    };
  }

  async function budget(
    f: Awaited<ReturnType<typeof fixture>>,
    dailyLimitMinor: number,
  ): Promise<void> {
    await f.usage.upsertBudget(f.owner, { currency: "USD", dailyLimitMinor, reason: "m08 test" });
  }

  it("refuses a direct ScriptService.generate with BUDGET_EXHAUSTED and never calls the provider", async () => {
    if (!db) return;
    const llm = countingLlm();
    const f = await fixture(llm);
    await budget(f, 50); // the 1 USD estimate (100 minor) cannot fit
    const refused = await f.script.generate(f.owner, f.body("refused")).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BudgetExhaustedError);
    expect((refused as BudgetExhaustedError).getStatus()).toBe(409);
    expect((refused as BudgetExhaustedError).code).toBe("BUDGET_EXHAUSTED");
    expect(llm.calls).toBe(0);
    // Refused before any M08 hold or ledger row exists: nothing to release, nothing charged.
    expect(await db.providerRequest.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    const m08 = await db.providerBudget.findFirstOrThrow({ where: { workspaceId: f.workspaceId } });
    expect(m08.reserved.toString()).toBe("0");
    expect(await db.usageReservation.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
    const summary = await f.usage.usageSummary(f.owner, {});
    expect(summary.totals.currencies).toEqual([]);
  });

  it("releases the M18 hold and marks the row NOT_DISPATCHED when the M08 daily guard refuses", async () => {
    if (!db) return;
    const llm = countingLlm();
    const f = await fixture(llm);
    await budget(f, 10_000);
    await db.providerBudget.updateMany({
      where: { workspaceId: f.workspaceId },
      data: { dailyLimit: 0.5 },
    });
    await expect(f.script.generate(f.owner, f.body("m08 cap"))).rejects.toThrow("daily budget");
    expect(llm.calls).toBe(0);
    const row = await db.providerRequest.findFirstOrThrow({
      where: { workspaceId: f.workspaceId },
    });
    expect(row).toMatchObject({ status: "FAILED", errorCode: "NOT_DISPATCHED" });
    expect(row.responseMetadata).toMatchObject({ dispatched: false });
    const hold = await db.usageReservation.findFirstOrThrow({
      where: { workspaceId: f.workspaceId },
    });
    expect(hold.status).toBe("RELEASED");
    const summary = await f.usage.usageSummary(f.owner, {});
    expect(summary.totals.notDispatchedRequests).toBe(1);
    expect(summary.totals.currencies[0]).toMatchObject({ currency: "USD", totalMinor: 0 });
    const [status] = await f.usage.listBudgets(f.owner);
    expect(status?.periods[0]?.consumedMinor).toBe(0);
  });

  it("lets exactly one of two concurrent calls dispatch at the limit", async () => {
    if (!db) return;
    const llm = countingLlm({ delayMs: 50 });
    const f = await fixture(llm);
    await budget(f, 150); // room for one 100-minor call, not two
    const results = await Promise.allSettled([
      f.script.generate(f.owner, f.body("one")),
      f.script.generate(f.owner, f.body("two")),
    ]);
    expect(llm.calls).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
      BudgetExhaustedError,
    );
    const [status] = await f.usage.listBudgets(f.owner);
    expect(status?.periods[0]?.consumedMinor).toBe(100);
  });

  it("counts a committed call once (reservation replaces its ledger row)", async () => {
    if (!db) return;
    const llm = countingLlm({ cost: 0.4 });
    const f = await fixture(llm);
    await budget(f, 10_000);
    await f.script.generate(f.owner, f.body("ok"));
    const reservation = await db.usageReservation.findFirstOrThrow({
      where: { workspaceId: f.workspaceId },
    });
    const row = await db.providerRequest.findFirstOrThrow({
      where: { workspaceId: f.workspaceId },
    });
    expect(reservation).toMatchObject({
      status: "COMMITTED",
      correlationId: row.correlationId,
      idempotencyKey: `m08:${row.correlationId}`,
      category: "LLM",
    });
    expect(reservation.committedMinor).toBe(40n); // actual cost, not the estimate
    const summary = await f.usage.usageSummary(f.owner, {});
    expect(summary.totals.currencies[0]).toMatchObject({
      currency: "USD",
      totalMinor: 40,
      committedMinor: 40,
      actualMinor: 0,
    });
    const [status] = await f.usage.listBudgets(f.owner);
    expect(status?.periods[0]?.consumedMinor).toBe(40);
  });

  it("charges a call that failed after dispatch at its estimate", async () => {
    if (!db) return;
    const llm = countingLlm({ fail: true });
    const f = await fixture(llm);
    await budget(f, 10_000);
    await expect(f.script.generate(f.owner, f.body("boom"))).rejects.toThrow("timed out");
    expect(llm.calls).toBe(1);
    const reservation = await db.usageReservation.findFirstOrThrow({
      where: { workspaceId: f.workspaceId },
    });
    expect(reservation.status).toBe("COMMITTED");
    expect(reservation.committedMinor).toBe(100n);
    const [status] = await f.usage.listBudgets(f.owner);
    expect(status?.periods[0]?.consumedMinor).toBe(100);
  });

  it("proceeds without an M18 hold when no budget is configured (manual rule)", async () => {
    if (!db) return;
    const llm = countingLlm();
    const f = await fixture(llm);
    await f.script.generate(f.owner, f.body("unbudgeted"));
    expect(llm.calls).toBe(1);
    expect(await db.usageReservation.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
  });
});
