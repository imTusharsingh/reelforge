import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { RunsModule } from "./runs.module.js";
import { RunsService } from "./runs.service.js";
import { RunsController } from "./runs.controller.js";
import { RunsArtifacts } from "./runs.artifacts.js";
import { RunsControl } from "./runs.control.js";
import { RunsStore } from "./runs.store.js";
import type { Artifact } from "./runs.types.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { WorkspaceRepository } from "../workspace/workspace.repository.js";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { runsFixture, type Tenant } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("V3 run HTTP boundary", () => {
  const fixture = runsFixture();
  let t: Tenant, other: Tenant, app: INestApplication;
  let artifact: Artifact, artifactStepId: string;
  const token = randomUUID();
  afterEach(() => vi.unstubAllEnvs());
  beforeAll(async () => {
    t = await fixture.tenant("L2", 45, null, false);
    other = await fixture.tenant("L2", 45, null, false);
    // Delivery only needs a persisted artifact and its bytes. Running generation here
    // can leave a worker transaction in flight after Vitest times out the test.
    artifact = await t.artifacts.put(t.context, "clips", Buffer.from("fixture clip"), "video/mp4");
    const step = await t.store.scoped(t.context).videoRunStep.create({
      data: {
        workspaceId: t.context.workspaceId,
        runId: t.run.id,
        key: "shot-0",
        state: "SUCCEEDED",
        idempotencyKey: randomUUID(),
        input: {},
        output: { storageArtifacts: [artifact] },
      },
    });
    artifactStepId = step.id;
    await t.db.session.create({
      data: {
        userId: t.context.userId,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    const module = await Test.createTestingModule({ imports: [RunsModule] })
      .overrideProvider("DATABASE")
      .useValue(t.db)
      .overrideProvider(RunsStore)
      .useValue(t.store)
      .overrideProvider(RunsService)
      .useValue(t.runs)
      .overrideProvider(RunsArtifacts)
      .useValue(t.artifacts)
      .overrideProvider(RunsControl)
      .useValue(t.control)
      .overrideProvider(WorkspaceService)
      .useValue(new WorkspaceService(t.db, new WorkspaceRepository(t.db)))
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  it("returns 202 with a durable id even when provider submission would never resolve", async () => {
    const submit = vi
      .spyOn(t.generation.provider, "submit")
      .mockImplementation(() => new Promise(() => undefined));
    const result = await request(app.getHttpServer() as never)
      .post("/api/v1/runs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        workspaceId: t.context.workspaceId,
        channelBriefId: t.brief.id,
        idempotencyKey: randomUUID(),
      })
      .timeout(3000)
      .expect(202);
    expect(result.body.id).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
    submit.mockRestore();
    await request(app.getHttpServer() as never)
      .get(`/api/v1/runs/${result.body.id}?workspaceId=${t.context.workspaceId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
  });
  it("enforces authentication, workspace membership, UUID and body validation", async () => {
    await request(app.getHttpServer() as never)
      .post("/api/v1/runs")
      .send({})
      .expect(401);
    await request(app.getHttpServer() as never)
      .post("/api/v1/runs")
      .set("Authorization", `Bearer ${token}`)
      .send({})
      .expect(400);
    await request(app.getHttpServer() as never)
      .get(`/api/v1/runs/${other.run.id}?workspaceId=${other.context.workspaceId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    await request(app.getHttpServer() as never)
      .get(`/api/v1/runs/nope?workspaceId=${t.context.workspaceId}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
  });
  it("validates SSE cursors and supports read and control controller boundaries", async () => {
    const controller = app.get(RunsController);
    const req = { principal: { userId: t.context.userId, sessionId: randomUUID() } };
    await expect(
      controller.events(req as never, t.run.id, t.context.workspaceId, "bad", undefined),
    ).rejects.toThrow();
    await expect(
      controller.events(
        req as never,
        t.run.id,
        t.context.workspaceId,
        undefined,
        "9007199254740992",
      ),
    ).rejects.toThrow();
    const transport = t.runs.events;
    t.runs.events = null;
    await expect(
      controller.events(req as never, t.run.id, t.context.workspaceId, undefined, "0"),
    ).rejects.toThrow();
    t.runs.events = transport;
    await expect(
      controller.reshoot(req as never, t.run.id, "-1", t.context.workspaceId),
    ).rejects.toThrow();
    await expect(
      controller.resume(req as never, t.run.id, t.context.workspaceId),
    ).rejects.toThrow();
    await expect(
      controller.approve(req as never, t.run.id, t.context.workspaceId),
    ).rejects.toThrow();
    await expect(
      controller.reedit(req as never, t.run.id, t.context.workspaceId),
    ).rejects.toThrow();
  });
  it("serves checksum-addressed signed artifacts with tenant and expiry checks", async () => {
    const url = t.artifacts.sign(t.context, t.run.id, artifactStepId, artifact);
    await request(app.getHttpServer() as never)
      .get(url)
      .set("Authorization", `Bearer ${token}`)
      .timeout(3000)
      .expect("Content-Type", "video/mp4")
      .expect(200);
    await request(app.getHttpServer() as never)
      .get(url.replace(/signature=[a-f0-9]+/, "signature=bad"))
      .set("Authorization", `Bearer ${token}`)
      .timeout(3000)
      .expect(403);
    const parsed = new URL(url, "http://fixture.invalid");
    await expect(
      t.artifacts.get(
        t.context,
        t.run.id,
        artifactStepId,
        artifact.checksumSha256,
        0,
        parsed.searchParams.get("signature")!,
      ),
    ).rejects.toThrow();
    await expect(
      t.artifacts.get(
        other.context,
        t.run.id,
        artifactStepId,
        artifact.checksumSha256,
        Number(parsed.searchParams.get("expires")),
        parsed.searchParams.get("signature")!,
      ),
    ).rejects.toThrow();
    expect(t.artifacts.views(t.context, t.run.id, artifactStepId, [{ bad: true }])).toEqual([]);
    await t.storage.putObject({
      workspaceId: t.context.workspaceId,
      objectKey: artifact.objectKey,
      body: Buffer.from("corruption"),
      contentType: artifact.contentType,
    });
    await expect(
      t.artifacts.get(
        t.context,
        t.run.id,
        artifactStepId,
        artifact.checksumSha256,
        Number(parsed.searchParams.get("expires")),
        parsed.searchParams.get("signature")!,
      ),
    ).rejects.toThrow("integrity validation");
  });
});
