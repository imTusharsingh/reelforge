import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
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
import { generateClips, generating, runsFixture, type Tenant } from "./runs.fixture.js";

describe.skipIf(!process.env.DATABASE_URL)("V3 run HTTP boundary", () => {
  const fixture = runsFixture();
  let t: Tenant, other: Tenant, app: INestApplication;
  let artifact: Artifact, artifactStepId: string, artifactRunId: string;
  const token = randomUUID();
  afterEach(() => vi.unstubAllEnvs());
  beforeAll(async () => {
    t = await fixture.tenant("L2", 30);
    other = await fixture.tenant("L2", 45, null, false);
    artifactRunId = (await t.runs.create(t.context, t.brief.id, randomUUID())).id;
    artifact = await t.artifacts.put(t.context, "clips", Buffer.from("fixture clip"), "video/mp4");
    const step = await t.store.scoped(t.context).videoRunStep.create({
      data: {
        workspaceId: t.context.workspaceId,
        runId: artifactRunId,
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
  it("records owner-recovered text evidence on the original dispatched attempt without posting or marking it verified", async () => {
    const receiptTenant = await fixture.tenant("L2", 30);
    const owner = randomUUID();
    await receiptTenant.db.session.create({
      data: {
        userId: receiptTenant.context.userId,
        tokenHash: hashSessionToken(owner),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const run = receiptTenant.run;
    await receiptTenant.engine.process(receiptTenant.runs.job(receiptTenant.context, run.id));
    const current = await receiptTenant.store.get(receiptTenant.context, run.id);
    const native = fakeMediaPorts(
      receiptTenant.context.workspaceId,
      receiptTenant.storage,
      {
        clip: Buffer.alloc(0),
        image: Buffer.alloc(0),
        audio: Buffer.alloc(0),
      },
      [],
    );
    const { accounts } = bindMedia(receiptTenant, native);
    const step = await accounts.begin(
      receiptTenant.context,
      current,
      "media:text:scriptwriter",
      {},
      7,
      "fixture-text",
    );
    await accounts.prepare(receiptTenant.context, current, step, "fixture-text");
    const sent = vi.fn().mockRejectedValue(new Error("lost reply"));
    await expect(accounts.dispatchText(receiptTenant.context, step, sent)).rejects.toThrow(
      "RECONCILE_REQUIRED",
    );

    const path = `/api/v1/runs/${run.id}/steps/${step.id}/text-evidence?workspaceId=${receiptTenant.context.workspaceId}`;
    const data = {
      dispatchKey: step.idempotencyKey,
      providerJobId: "google_fixture_recovered",
      confirmedOriginalAttempt: true,
      usage: { input_tokens: 12 },
    };
    const editor = randomUUID();
    await receiptTenant.db.workspaceMembership.create({
      data: {
        workspaceId: receiptTenant.context.workspaceId,
        userId: other.context.userId,
        role: "EDITOR",
      },
    });
    await receiptTenant.db.session.create({
      data: {
        userId: other.context.userId,
        tokenHash: hashSessionToken(editor),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const post = (asToken: string): request.Test =>
      request(app.getHttpServer() as never)
        .post(path)
        .set("Authorization", `Bearer ${asToken}`);
    await request(app.getHttpServer() as never)
      .post(path)
      .send(data)
      .expect(401);
    await post(editor).send(data).expect(403);
    await post(owner)
      .send({ ...data, dispatchKey: "wrong-attempt" })
      .expect(409);
    await post(owner).send(data).expect(204);
    await receiptTenant.control.abandonTerminalText(receiptTenant.context, run.id, step.id);
    await post(owner)
      .send({ ...data, usage: { output_tokens: 3 } })
      .expect(204);
    expect(
      await receiptTenant.db.providerRequest.findFirstOrThrow({
        where: { correlationId: step.id },
      }),
    ).toMatchObject({
      actualCost: null,
      usage: null,
      responseMetadata: {
        dispatchKey: step.idempotencyKey,
        ownerReportedEvidence: {
          providerJobId: data.providerJobId,
          usage: { input_tokens: 12, output_tokens: 3 },
          recordedBy: receiptTenant.context.userId,
        },
      },
    });
    expect(
      await receiptTenant.db.usageReservation.findMany({ where: { correlationId: step.id } }),
    ).toMatchObject([{ status: "COMMITTED", committedMinor: 7n }]);
    const fill = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`counter_${index}`, 1]),
    );
    await post(owner)
      .send({ ...data, usage: fill })
      .expect(204);
    const readReceipt = (): ReturnType<Tenant["db"]["providerRequest"]["findFirstOrThrow"]> =>
      receiptTenant.db.providerRequest.findFirstOrThrow({ where: { correlationId: step.id } });
    const bounded = await readReceipt();
    expect(
      await receiptTenant.db.runEvent.findFirst({
        where: { stepId: step.id, type: "text_evidence_recorded" },
        orderBy: { sequence: "desc" },
      }),
    ).toMatchObject({ payload: { usage: fill } });
    expect(bounded.responseMetadata).toMatchObject({
      ownerReportedEvidence: {
        providerJobId: data.providerJobId,
        usage: { input_tokens: 12, output_tokens: 3, ...fill },
      },
    });
    const revision = (await receiptTenant.store.get(receiptTenant.context, run.id)).revision;
    const evidenceEvents = { stepId: step.id, type: "text_evidence_recorded" };
    const eventCount = await receiptTenant.db.runEvent.count({ where: evidenceEvents });
    await post(owner)
      .send({ ...data, usage: { one_too_many: 1 } })
      .expect(409);
    await post(owner)
      .send({ ...data, providerJobId: "google_other" })
      .expect(409);
    expect(await readReceipt()).toEqual(bounded);
    expect((await receiptTenant.store.get(receiptTenant.context, run.id)).revision).toBe(revision);
    expect(await receiptTenant.db.runEvent.count({ where: evidenceEvents })).toBe(eventCount);
    await post(owner)
      .send({ ...data, usage: { input_tokens: 13 } })
      .expect(409);
    expect(await readReceipt()).toEqual(bounded);
    expect(await receiptTenant.db.runEvent.count({ where: evidenceEvents })).toBe(eventCount);
    await post(owner).send(data).expect(204);
    expect((await readReceipt()).responseMetadata).toMatchObject({
      ownerReportedEvidence: {
        providerJobId: data.providerJobId,
        usage: { input_tokens: 12, output_tokens: 3, ...fill },
      },
    });
    expect(sent).toHaveBeenCalledOnce();
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
      controller.reshoot(req as never, t.run.id, "-1", t.context.workspaceId, randomUUID()),
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
    const url = t.artifacts.sign(t.context, artifactRunId, artifactStepId, artifact);
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
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now - 6 * 60_000);
    let expiredUrl: string;
    try {
      expiredUrl = t.artifacts.sign(t.context, artifactRunId, artifactStepId, artifact);
    } finally {
      clock.mockRestore();
    }
    const expired = new URL(expiredUrl, "http://fixture.invalid");
    expect(Number(expired.searchParams.get("expires"))).toBe(now - 60_000);
    await request(app.getHttpServer() as never)
      .get(expiredUrl)
      .set("Authorization", `Bearer ${token}`)
      .timeout(3000)
      .expect(403);

    const otherUrl = new URL(
      t.artifacts.sign(other.context, artifactRunId, artifactStepId, artifact),
      "http://fixture.invalid",
    );
    await expect(
      t.artifacts.get(
        other.context,
        artifactRunId,
        artifactStepId,
        artifact.checksumSha256,
        Number(otherUrl.searchParams.get("expires")),
        otherUrl.searchParams.get("signature")!,
      ),
    ).rejects.toThrow("Run not found");
    expect(t.artifacts.views(t.context, artifactRunId, artifactStepId, [{ bad: true }])).toEqual(
      [],
    );
    await t.storage.putObject({
      workspaceId: t.context.workspaceId,
      objectKey: artifact.objectKey,
      body: Buffer.from("corruption"),
      contentType: artifact.contentType,
    });
    await expect(
      t.artifacts.get(
        t.context,
        artifactRunId,
        artifactStepId,
        artifact.checksumSha256,
        Number(parsed.searchParams.get("expires")),
        parsed.searchParams.get("signature")!,
      ),
    ).rejects.toThrow("integrity validation");
  });
  it("serves the generated clip and replays its HTTP reshoot after returning to CRITIC", async () => {
    expect((await generating(t)).state).toBe("GENERATING");
    vi.spyOn(t.generation.provider, "estimate").mockReturnValue(40);
    await generateClips(t);
    const step = await t.store.scoped(t.context).videoRunStep.findFirstOrThrow({
      where: { runId: t.run.id, key: "shot-0", state: "SUCCEEDED" },
    });
    const [clip] = t.artifacts.descriptors(step.output);
    expect(clip?.kind).toBe("clips");
    const expected = Buffer.from(
      JSON.stringify({ fixture: true, providerJobId: step.providerJobId }),
    );
    await request(app.getHttpServer() as never)
      .get(t.artifacts.sign(t.context, t.run.id, step.id, clip!))
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
        response.on("error", callback);
      })
      .timeout(3000)
      .expect("Content-Type", "video/mp4")
      .expect(200)
      .expect(({ body }) => expect(body).toEqual(expected));
    const parent = t.runs.job(t.context, t.run.id);
    await t.engine.process(parent);
    await t.engine.process({ ...parent, assembly: true });
    const path = `/api/v1/runs/${t.run.id}/reshoot/0?workspaceId=${t.context.workspaceId}`;
    const command = (url: string): request.Test =>
      request(app.getHttpServer() as never)
        .post(url)
        .set("Authorization", `Bearer ${token}`);
    await command(path).expect(400);
    const bound = `${path}&sourceStepId=${step.id}`;
    const submit = vi.spyOn(t.generation.provider, "submit");
    const accepted = await command(bound).expect(201);
    expect(accepted.body.stepId).toBeTruthy();
    await generateClips(t);
    await t.engine.process(parent);
    await t.engine.process({ ...parent, assembly: true });
    expect((await t.store.get(t.context, t.run.id)).state).toBe("CRITIC");
    await command(bound).expect(201, accepted.body);
    expect(await t.db.videoRunStep.count({ where: { runId: t.run.id, key: "shot-0" } })).toBe(2);
    expect(submit).toHaveBeenCalledOnce();
  }, 15000);
});
