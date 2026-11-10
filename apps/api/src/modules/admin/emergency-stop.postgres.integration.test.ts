import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { createDatabaseClient } from "@reelforge/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChannelService } from "../channel/channel.service.js";
import { StaticBudgetPolicy } from "../orchestration/orchestration.budget.js";
import { WorkflowLimitsService } from "../orchestration/orchestration.limits.js";
import { InMemoryWorkflowQueue } from "../orchestration/orchestration.queue.js";
import { OrchestrationService } from "../orchestration/orchestration.service.js";
import {
  DEFAULT_WORKFLOW_LIMIT_CONFIG,
  type WorkflowStepDispatchInput,
  type WorkflowStepDispatchResult,
  type WorkflowStepDispatcherPort,
} from "../orchestration/orchestration.types.js";
import { UnconfiguredPublishingSchedulePort } from "../publishing/publishing.ports.js";
import { UsageBudgetService } from "../usage-budget/usage-budget.service.js";
import { AuditService } from "./audit.service.js";
import {
  EmergencyStopBudgetPolicy,
  EmergencyStopPublishingSchedulePort,
} from "./emergency-stop.adapters.js";
import { EmergencyStopService } from "./emergency-stop.service.js";
import { EmergencyStopError } from "./emergency-stop.types.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);

const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const ownerId = randomUUID();
const editorId = randomUUID();
const otherOwnerId = randomUUID();
const channelId = randomUUID();
const secondChannelId = randomUUID();
const otherChannelId = randomUUID();
const ideaId = randomUUID();

const owner = { workspaceId, userId: ownerId, role: "OWNER" as const };
const editor = { workspaceId, userId: editorId, role: "EDITOR" as const };
const otherOwner = { workspaceId: otherWorkspaceId, userId: otherOwnerId, role: "OWNER" as const };

/** Fixture dispatcher: no live provider calls; records every dispatch (a "side effect"). */
class FixtureDispatcher implements WorkflowStepDispatcherPort {
  public readonly calls: WorkflowStepDispatchInput[] = [];
  public external = false;

  public async dispatchStep(input: WorkflowStepDispatchInput): Promise<WorkflowStepDispatchResult> {
    this.calls.push(input);
    if (this.external)
      return {
        resultRef: `external-${input.runId}`,
        resultType: input.stepKey,
        waitingExternal: { reason: "remote work running", pollDelayMs: 1_000 },
      };
    if (input.stepKey === "QUALITY_REVIEW")
      return {
        resultRef: `review-${input.runId}`,
        resultType: "QUALITY_REVIEW_RUN",
        waitingApproval: true,
      };
    return { resultRef: `${input.stepKey}-${input.runId}`, resultType: input.stepKey };
  }
}

suite("M19 emergency stop on PostgreSQL (T06)", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  let clockMs = Date.parse("2026-11-10T08:00:00.000Z");
  const clock = (): Date => new Date(clockMs);

  function stops(): EmergencyStopService {
    if (!db) throw new Error("database unavailable");
    return new EmergencyStopService(db as never, new AuditService(db as never));
  }

  function build(): {
    service: OrchestrationService;
    queue: InMemoryWorkflowQueue;
    dispatcher: FixtureDispatcher;
    stop: EmergencyStopService;
  } {
    if (!db) throw new Error("database unavailable");
    const stop = stops();
    const queue = new InMemoryWorkflowQueue();
    const dispatcher = new FixtureDispatcher();
    const channels = new ChannelService(db as never);
    const all = channels.listSchedulerCandidates.bind(channels);
    channels.listSchedulerCandidates = async (): ReturnType<typeof all> =>
      (await all()).filter((channel) => channel.workspaceId === workspaceId);
    const service = new OrchestrationService(
      db as never,
      queue,
      dispatcher,
      new EmergencyStopBudgetPolicy(stop, new StaticBudgetPolicy("ALLOWED")),
      new WorkflowLimitsService(db as never, {
        ...DEFAULT_WORKFLOW_LIMIT_CONFIG,
        rateLimitPerMinute: 10_000,
      }),
      channels,
      { get: async (_c: unknown, id: string) => ({ id, status: "REVIEW_REQUIRED" }) } as never,
      clock,
      stop,
    );
    return { service, queue, dispatcher, stop };
  }

  async function drainOnce(
    service: OrchestrationService,
    queue: InMemoryWorkflowQueue,
  ): Promise<string[]> {
    const statuses: string[] = [];
    clockMs += 61_000;
    for (const job of queue.take())
      statuses.push((await service.processJob(job, "worker-a")).status);
    return statuses;
  }

  async function setWorkspaceStop(active: boolean): Promise<void> {
    await stops().set(owner, {
      scope: "WORKSPACE",
      active,
      reason: active ? "Incident 42" : "Resolved",
    });
  }

  beforeAll(async () => {
    if (!db) return;
    await db.user.createMany({
      data: [ownerId, editorId, otherOwnerId].map((id) => ({
        id,
        email: `${id}@m19.integration.invalid`,
      })),
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "m19-stop" },
        { id: otherWorkspaceId, name: "m19-stop-other" },
      ],
    });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: ownerId, role: "OWNER" },
        { workspaceId, userId: editorId, role: "EDITOR" },
        { workspaceId: otherWorkspaceId, userId: otherOwnerId, role: "OWNER" },
      ],
    });
    await db.channel.createMany({
      data: [
        {
          id: channelId,
          workspaceId,
          name: "m19-active",
          timezone: "UTC",
          schedule: { time: "09:00", frequency: "DAILY", input: { ideaId } },
        },
        { id: secondChannelId, workspaceId, name: "m19-second" },
        { id: otherChannelId, workspaceId: otherWorkspaceId, name: "m19-other" },
      ],
    });
  });

  beforeEach(async () => {
    if (!db) return;
    clockMs = Date.parse("2026-11-10T08:00:00.000Z");
    await db.emergencyStop.deleteMany({
      where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
    });
    await db.workflowLimitLease.deleteMany({ where: { workspaceId } });
    await db.workflowRun.updateMany({
      where: { workspaceId, state: { in: ["QUEUED", "RUNNING", "RETRY_WAIT", "PAUSED"] } },
      data: { state: "CANCELED" },
    });
    delete process.env["REELFORGE_EMERGENCY_STOP"];
  });

  afterAll(async () => {
    if (!db) return;
    delete process.env["REELFORGE_EMERGENCY_STOP"];
    await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    await db.user.deleteMany({ where: { id: { in: [ownerId, editorId, otherOwnerId] } } });
    await db.$disconnect();
  });

  it("lets only the OWNER set and clear a stop, scoped to their own workspace, with an ADMIN audit", async () => {
    if (!db) return;
    const stop = stops();
    await expect(
      stop.set(editor, { scope: "WORKSPACE", active: true, reason: "nope" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      stop.set(owner, {
        scope: "CHANNEL",
        channelId: otherChannelId,
        active: true,
        reason: "cross tenant",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const set = await stop.set(owner, {
      scope: "CHANNEL",
      channelId,
      active: true,
      reason: "Bad upload",
    });
    expect(set).toMatchObject({
      scope: "CHANNEL",
      channelId,
      active: true,
      version: 1,
      setByUserId: ownerId,
    });
    await expect(stop.check({ workspaceId, channelId })).resolves.toMatchObject({
      stopped: true,
      scope: "CHANNEL",
    });
    await expect(stop.check({ workspaceId, channelId: secondChannelId })).resolves.toMatchObject({
      stopped: false,
    });
    await expect(
      stop.check({ workspaceId: otherWorkspaceId, channelId: otherChannelId }),
    ).resolves.toMatchObject({
      stopped: false,
    });
    await expect(
      stop.set(owner, {
        scope: "CHANNEL",
        channelId,
        active: false,
        reason: "Fixed",
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const cleared = await stop.set(owner, {
      scope: "CHANNEL",
      channelId,
      active: false,
      reason: "Fixed",
    });
    expect(cleared).toMatchObject({ active: false, clearedByUserId: ownerId, version: 2 });
    const audits = await db.auditEvent.findMany({
      where: { workspaceId, category: "ADMIN" },
      orderBy: { occurredAt: "asc" },
    });
    expect(audits.map((row) => row.action).slice(-2)).toEqual([
      "EMERGENCY_STOP_SET",
      "EMERGENCY_STOP_CLEARED",
    ]);
    expect(audits.at(-2)).toMatchObject({ actorUserId: ownerId, outcome: "SUCCESS" });
    expect(audits.at(-2)?.metadata).toMatchObject({
      scope: "CHANNEL",
      reason: "Bad upload",
      before: null,
    });
    const status = await stop.status(otherOwner);
    expect(status.stops).toEqual([]);
  });

  it("blocks new runs, pauses queued work at the next step, and resumes only after the stop is cleared", async () => {
    if (!db) return;
    const { service, queue, dispatcher } = build();
    const run = await service.startManualRun(editor, {
      definitionKey: "GENERATION",
      channelId,
      ideaId,
    });
    expect(run.state).toBe("QUEUED");
    await setWorkspaceStop(true);
    await expect(
      service.startManualRun(editor, { definitionKey: "GENERATION", channelId, ideaId }),
    ).rejects.toThrow(/EMERGENCY_STOP/);
    await expect(drainOnce(service, queue)).resolves.toEqual(["PAUSED"]);
    expect(dispatcher.calls).toHaveLength(0);
    const paused = await service.getRun(editor, run.id);
    expect(paused).toMatchObject({ state: "PAUSED", pausedReason: "EMERGENCY_STOP" });
    const pausedEvent = await db.workflowEvent.findFirst({
      where: { workspaceId, runId: run.id, eventType: "WORKFLOW_RUN_PAUSED" },
    });
    expect(pausedEvent?.payload).toMatchObject({ reason: "EMERGENCY_STOP" });
    await expect(service.resumeRun(editor, run.id)).rejects.toThrow(/Emergency stop/);
    await setWorkspaceStop(false);
    const resumed = await service.resumeRun(editor, run.id);
    expect(resumed.state).toBe("QUEUED");
    await drainOnce(service, queue);
    expect(dispatcher.calls.length).toBeGreaterThan(0);
  });

  it("keeps polling external work that already exists (safe reconciliation) while stopped", async () => {
    if (!db) return;
    const { service, queue, dispatcher } = build();
    dispatcher.external = true;
    const run = await service.startManualRun(editor, {
      definitionKey: "GENERATION",
      channelId,
      ideaId,
    });
    await drainOnce(service, queue);
    expect(dispatcher.calls).toHaveLength(1);
    await setWorkspaceStop(true);
    await drainOnce(service, queue);
    expect(dispatcher.calls).toHaveLength(2);
    expect(dispatcher.calls[1]?.previousResultRef).toBe(`external-${run.id}`);
    const current = await service.getRun(editor, run.id);
    expect(current.state).not.toBe("PAUSED");
  });

  it("skips scheduled slots with EMERGENCY_STOP and stays per-tenant", async () => {
    if (!db) return;
    const { service } = build();
    await setWorkspaceStop(true);
    clockMs = Date.parse("2026-11-10T09:01:00.000Z");
    const tick = await service.runSchedulerTick(clock());
    expect(tick.startedRuns).toBe(0);
    const slot = await db.workflowScheduleSlot.findFirst({
      where: { workspaceId, channelId },
      orderBy: { createdAt: "desc" },
    });
    expect(slot).toMatchObject({ status: "SKIPPED", reason: "EMERGENCY_STOP" });
    const policy = new EmergencyStopBudgetPolicy(stops(), new StaticBudgetPolicy("ALLOWED"));
    await expect(
      policy.evaluate({
        workspaceId: otherWorkspaceId,
        channelId: otherChannelId,
        definitionKey: "GENERATION",
        trigger: "SCHEDULED",
      }),
    ).resolves.toEqual({ decision: "ALLOWED", reason: null });
  });

  it("refuses paid M08 calls and publish preflight before any reservation or upload", async () => {
    if (!db) return;
    await setWorkspaceStop(true);
    const usage = new UsageBudgetService(db as never, () => new Date(), stops());
    await expect(
      usage.reservePaidCall({
        workspaceId,
        channelId,
        correlationId: randomUUID(),
        category: "LLM",
        currency: "USD",
        estimate: 0.5,
      }),
    ).rejects.toBeInstanceOf(EmergencyStopError);
    expect(await db.usageReservation.count({ where: { workspaceId } })).toBe(0);
    const publishing = new EmergencyStopPublishingSchedulePort(
      stops(),
      new UnconfiguredPublishingSchedulePort(),
    );
    const check = await publishing.check({
      workspaceId,
      channelId,
      scheduledAt: null,
      platform: "YOUTUBE",
      destinationId: randomUUID(),
      idempotencyKey: "k",
    });
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/^EMERGENCY_STOP/);
  });

  it("applies the operator GLOBAL stop from the environment to every workspace", async () => {
    if (!db) return;
    process.env["REELFORGE_EMERGENCY_STOP"] = "1";
    await expect(stops().check({ workspaceId: otherWorkspaceId })).resolves.toMatchObject({
      stopped: true,
      scope: "GLOBAL",
    });
    const status = await stops().status(otherOwner);
    expect(status.global).toMatchObject({ scope: "GLOBAL", active: true });
    delete process.env["REELFORGE_EMERGENCY_STOP"];
    await expect(stops().check({ workspaceId: otherWorkspaceId })).resolves.toMatchObject({
      stopped: false,
    });
  });
});
