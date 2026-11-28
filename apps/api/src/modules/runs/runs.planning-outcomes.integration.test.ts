import { createHash, randomUUID } from "node:crypto";
import { ModuleRef } from "@nestjs/core";
import {
  GeminiText,
  Interactions,
  ProviderHttp,
  type PaidTextTransport,
} from "@reelforge/ai-providers";
import { afterEach, expect, it, vi } from "vitest";
import { MediaAccounts } from "../scene-media/media-accounts.js";
import { MediaJobs } from "../scene-media/media-jobs.js";
import { MediaPlanning } from "../scene-media/media-planning.js";
import type { MediaPorts } from "../scene-media/media-ports.js";
import { PlanningPromptService } from "../config/planning-prompt.service.js";
import { RunPaidCalls } from "../usage-budget/run-paid.js";
import { RunsBoundary } from "./runs.boundary.js";
import { runsFixture, type Tenant } from "./runs.fixture.js";

const fixture = runsFixture();
afterEach(() => vi.unstubAllEnvs());

it.skipIf(!process.env.DATABASE_URL)(
  "closes the planning text attempt and fails closed on the next pass",
  async () => {
    const narrator = {
      providerId: "gemini" as const,
      voiceId: "narrator",
      pace: 1,
      language: "English",
    };
    const t = await fixture.tenant("L2", 42, narrator, false);
    await t.engine.process(t.runs.job(t.context, t.run.id));
    const run = await t.store.get(t.context, t.run.id);
    vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
    vi.stubEnv("GEMINI_TEXT_MODEL", "text-fixture");
    const transport = vi.fn<PaidTextTransport>(async (_url, _request, sent) => {
      await sent();
      return Response.json(
        { error: { status: "INVALID_ARGUMENT", message: "untrusted remote text" } },
        { status: 400 },
      );
    });
    const http = new ProviderHttp(
      "AIza" + "aB1".repeat(12),
      "gemini",
      undefined,
      10_000,
      transport,
    );
    const text = new GeminiText(
      new Interactions(http, {
        save: async (): Promise<never> => {
          throw new Error("Unexpected provider artifact");
        },
      }),
      "text-fixture",
    );
    const paid = new RunPaidCalls(t.usage, t.store);
    const prompt = {
      capture: vi.fn<PlanningPromptService["capture"]>().mockResolvedValue({
        prompt: "fixture prompt",
        receipt: {
          role: "scriptwriter",
          version: 2,
          templateVersionId: randomUUID(),
          promptSnapshotId: randomUUID(),
          configSnapshotId: randomUUID(),
          fingerprintSha256: createHash("sha256").update("fixture").digest("hex"),
        },
      }),
      format: vi.fn<PlanningPromptService["format"]>().mockResolvedValue({}),
    };
    const boundary = new RunsBoundary(
      { check: async (): Promise<Tenant["stop"]> => t.stop },
      t.runs,
    );
    const modules = {
      get: (token: unknown): unknown => (token === PlanningPromptService ? prompt : {}),
    } as ModuleRef;
    const access = { modules, runs: t.runs, paid, artifacts: t.artifacts, boundary };
    const accounts = new MediaAccounts(access);
    const jobs = new MediaJobs(access, accounts, t.storage);
    const ports = { get: vi.fn().mockResolvedValue({ text }) } as unknown as MediaPorts;
    const planning = new MediaPlanning(access, accounts, jobs, ports);
    const plan = async (): Promise<never> => {
      await planning.plan(t.context, run, t.brief);
      throw new Error("Unexpected successful plan");
    };
    t.planning.handlers = { ...t.planning.handlers, SCRIPTING: { execute: plan, reconcile: plan } };

    await expect(t.engine.process(t.runs.job(t.context, run.id))).rejects.toMatchObject({
      kind: "INVALID",
      dispatched: false,
      http: { status: 400, code: "INVALID_ARGUMENT" },
    });
    const db = t.store.scoped(t.context);
    const step = await db.videoRunStep.findFirstOrThrow({
      where: { runId: run.id, key: "media:text:scriptwriter" },
    });
    expect(step).toMatchObject({
      state: "FAILED",
      costMinor: 0,
      error: { code: "INVALID_ARGUMENT" },
    });
    const where = { workspaceId: t.context.workspaceId, correlationId: step.id };
    const request = await t.db.providerRequest.findFirstOrThrow({ where });
    const reservation = await t.db.usageReservation.findFirstOrThrow({ where });
    expect(request).toMatchObject({
      errorCode: "INVALID_ARGUMENT",
      responseMetadata: { dispatched: true, costKnown: true },
    });
    expect(request.actualCost?.toString()).toBe("0");
    const evidence = await t.db.textAttemptEvidence.findFirstOrThrow({
      where: { workspaceId: t.context.workspaceId, attemptId: step.id, kind: "REJECTED" },
    });
    expect(evidence.data).toMatchObject({
      code: "INVALID_ARGUMENT",
      httpStatus: 400,
      dispatchKey: step.idempotencyKey,
    });
    expect(reservation).toMatchObject({ status: "RELEASED", committedMinor: null });
    expect(await t.store.get(t.context, t.run.id)).toMatchObject({
      state: "FAILED",
      pauseReason: "INVALID_ARGUMENT",
    });
    expect(
      await db.videoRunStep.findFirstOrThrow({ where: { runId: run.id, key: "SCRIPTING" } }),
    ).toMatchObject({ state: "FAILED" });
    await expect(planning.plan(t.context, run, t.brief)).rejects.toThrow(
      "Planning provider request was rejected",
    );
    await expect(t.engine.process(t.runs.job(t.context, run.id))).resolves.toBeNull();
    expect(transport).toHaveBeenCalledOnce();
  },
);
