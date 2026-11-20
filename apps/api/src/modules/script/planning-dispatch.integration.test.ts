import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import type { ClipArtifact, MediaJobPort } from "@reelforge/ai-providers";
import type { PlanningPromptReceipt, PlanningRequest } from "@reelforge/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ArtDirector } from "../character/art-director.service.js";
import type { Director, Scriptwriter } from "./planning-agents.js";
import { ReferenceLibraryService } from "../reference-library/reference-library.service.js";
import { RunsBoundary } from "../runs/runs.boundary.js";
import { runsFixture, type Tenant } from "../runs/runs.fixture.js";
import type { MediaAccess } from "../scene-media/media-access.js";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { planningFixture, scriptFixture, shotsFixture } from "./planning.fixture.js";
import { PlanningService } from "./planning.service.js";

const body = Buffer.from("offline reference bytes");
const checksumSha256 = createHash("sha256").update(body).digest("hex");
const narrator = planningFixture().brief.narratorVoice;

function media(t: Tenant): {
  jobs: MediaJobs;
  library: ReferenceLibraryService;
  port: MediaJobPort<object>;
} {
  const access: Pick<MediaAccess, "runs" | "artifacts" | "paid" | "boundary"> = {
    runs: t.runs,
    artifacts: t.artifacts,
    paid: new RunPaidCalls(t.usage, t.store),
    boundary: new RunsBoundary({ check: async () => t.stop }, t.runs),
  };
  const accounts = new MediaAccounts(access as MediaAccess);
  return {
    jobs: new MediaJobs(access as MediaAccess, accounts, t.storage),
    library: new ReferenceLibraryService(t.db),
    port: {
      submit: vi.fn(async () => ({ providerJobId: randomUUID() })),
      poll: vi.fn(async () => "succeeded" as const),
      fetch: async (): Promise<ClipArtifact> => {
        await t.storage.putObject({
          workspaceId: t.context.workspaceId,
          objectKey: "fixture.png",
          body,
          contentType: "image/png",
        });
        return {
          objectKey: "fixture.png",
          checksumSha256,
          mimeType: "image/png",
          byteSize: body.length,
          durationSeconds: 0,
          width: 1,
          height: 1,
          fps: 0,
          billedSeconds: null,
        };
      },
    },
  };
}
function receipt(role: PlanningPromptReceipt["role"]): PlanningPromptReceipt {
  return {
    role,
    version: 2,
    templateVersionId: randomUUID(),
    promptSnapshotId: randomUUID(),
    configSnapshotId: randomUUID(),
    fingerprintSha256: "a".repeat(64),
  };
}
function planner(
  t: Tenant,
  poll: () => Promise<"succeeded">,
): {
  request: PlanningRequest;
  service: PlanningService;
} {
  const { jobs, library, port } = media(t);
  port.poll = poll;
  const request: PlanningRequest = {
    runId: t.run.id,
    brief: t.brief,
    format: "explainer",
    idea: "Trees",
  };
  const service = new PlanningService(
    t.db,
    {
      write: async (): ReturnType<Scriptwriter["write"]> => ({
        script: scriptFixture(),
        prompt: receipt("scriptwriter"),
      }),
    },
    {
      direct: async (): ReturnType<Director["direct"]> => ({
        shots: shotsFixture(request).map((shot) => ({
          ...shot,
          workspaceId: t.context.workspaceId,
        })),
        prompt: receipt("director"),
      }),
    },
    {
      design: async (_context, _request, shots): ReturnType<ArtDirector["design"]> => {
        await jobs.wait(
          t.context,
          t.run,
          "reference:style",
          port,
          {},
          10,
          "offline",
          "art-director:v2",
        );
        return {
          shots: [...shots],
          references: [],
          voiceId: "fixture",
          prompt: receipt("art-director"),
        };
      },
    },
    library,
  );
  return { request, service };
}

describe.skipIf(!process.env.DATABASE_URL)("planning ownership and paid dispatch", () => {
  const fixture = runsFixture(1);

  it("admits a bounded contender with both planners blocked in provider polling and one application connection", async () => {
    const first = await fixture.tenant("L2", 45, narrator, false);
    const second = await fixture.tenant("L2", 45, narrator, false);
    const blocked = Promise.withResolvers<"succeeded">();
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const planners = [first, second].map((tenant, i) =>
      planner(tenant, async () => {
        entered[i]!.resolve();
        return blocked.promise;
      }),
    );
    const active = planners.map(({ request, service }, i) =>
      service.plan([first, second][i]!.context, request),
    );
    const completion = Promise.allSettled(active);
    try {
      await Promise.race([
        Promise.all(entered.map(({ promise }) => promise)),
        Promise.race(active),
      ]);
      const original = planners[0]!;
      const contender = await Promise.race([
        original.service.plan(first.context, original.request).catch((error: unknown) => error),
        new Promise((resolve) => setTimeout(resolve, 1000, "contender timed out")),
      ]);
      expect(contender).toMatchObject({ status: 409 });
      expect(await first.db.shotSpec.count({ where: { runId: first.run.id } })).toBe(0);
    } finally {
      blocked.resolve("succeeded");
      const results = await completion;
      expect(results).toEqual([
        { status: "fulfilled", value: expect.objectContaining({ manifest: expect.any(Object) }) },
        { status: "fulfilled", value: expect.objectContaining({ manifest: expect.any(Object) }) },
      ]);
    }
    expect(await first.db.shotSpec.count({ where: { runId: first.run.id } })).toBe(6);
  });

  it("confirms non-dispatch and refunds ledgers when the reference session dies during accounting", async () => {
    const t = await fixture.tenant("L2", 45, narrator, false);
    const { jobs, library, port } = media(t);
    await t.db.budgetEnvelope.create({
      data: {
        workspaceId: t.context.workspaceId,
        runId: t.run.id,
        currency: "USD",
        baseEstimateMinor: 200,
        reshootReserveMinor: 100,
        hardCapMinor: 800,
        route: "PRIMARY",
      },
    });
    const entered = Promise.withResolvers<void>();
    const blocker = new Client({ connectionString: process.env.DATABASE_URL! });
    await blocker.connect();
    await blocker.query("BEGIN");
    const mutate = t.store.mutate.bind(t.store);
    const spy = vi.spyOn(t.store, "mutate").mockImplementation(async (context, id, type, work) => {
      if (type === "provider_dispatch") {
        await blocker.query("SELECT id FROM provider_requests WHERE workspace_id = $1 FOR UPDATE", [
          context.workspaceId,
        ]);
        entered.resolve();
      }
      return mutate(context, id, type, work);
    });
    const pending = library.withInitializationLock(
      t.context,
      t.run.channelId,
      async (assertLocked) => {
        await assertLocked();
        return jobs.wait(
          t.context,
          t.run,
          "reference:style",
          port,
          {},
          10,
          "offline",
          "art-director:v2",
          0,
          assertLocked,
        );
      },
    );
    const failure = expect(pending).rejects.toMatchObject({ status: 409 });
    try {
      await Promise.race([entered.promise, pending]);
      const deadline = Date.now() + 1500;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const status = await blocker.query<{ blocked: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
          ) AS blocked
        `);
        blocked = status.rows[0]?.blocked === true;
        if (!blocked) await sleep(10);
      }
      expect(blocked).toBe(true);
      const key = `reference-init:${t.context.workspaceId}:${t.run.channelId}`;
      const stopped = await blocker.query(
        `
        SELECT pg_terminate_backend(pid, 1000) AS stopped FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND objsubid = 1
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)
      `,
        [key],
      );
      expect(stopped.rows).toEqual([{ stopped: true }]);
      await library.withInitializationLock(t.context, t.run.channelId, async () => undefined);
    } finally {
      spy.mockRestore();
      await blocker.query("ROLLBACK").finally(() => blocker.end());
      await failure;
    }
    expect(port.submit).not.toHaveBeenCalled();
    const step = await t.db.videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: "media:reference:style" },
    });
    expect(step).toMatchObject({ state: "CANCELLED", providerJobId: null });
    expect(await t.db.budgetEnvelope.findFirst({ where: { runId: t.run.id } })).toMatchObject({
      reservedMinor: 0,
      spentMinor: 0,
    });
    expect(
      await t.db.usageReservation.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: t.context.workspaceId,
            idempotencyKey: `m08:${step.idempotencyKey}`,
          },
        },
      }),
    ).toMatchObject({ status: "RELEASED", committedMinor: null, releaseReason: "NOT_DISPATCHED" });
    const request = await t.db.providerRequest.findUniqueOrThrow({
      where: {
        workspaceId_correlationId: { workspaceId: t.context.workspaceId, correlationId: step.id },
      },
    });
    expect(request).toMatchObject({
      status: "FAILED",
      errorCode: "NOT_DISPATCHED",
      responseMetadata: { dispatched: false, costKnown: true },
    });
    expect(request.actualCost?.toNumber()).toBe(0);
  });
});
