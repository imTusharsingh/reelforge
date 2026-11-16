import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createDatabaseClient, seedWorkspaceFoundations } from "@reelforge/database";
import { PROVIDER_REGISTRY, SCRIPT_LLM, ProviderRegistry } from "@reelforge/ai-providers";
import {
  compilePrompt,
  resolveConfig,
  CreativeConfigSchema,
  parsePromptTemplateBody,
} from "@reelforge/config-engine";
import { ScriptModule } from "./script.module.js";
import { IdeaModule } from "../idea/idea.module.js";
import { ChannelModule } from "../channel/channel.module.js";
import { ConfigModule } from "../config/config.module.js";
import type { ScriptLlmPort } from "./script.types.js";

const url = process.env.DATABASE_URL;
const document = {
  schemaVersion: "1.0",
  title: "Why leaves change",
  hook: "Why do leaves change color?",
  dialogue: "",
  narration: "Leaves reveal other pigments when chlorophyll fades.",
  cta: "Follow for more science.",
  metadata: { genre: "Explainer", targetDurationSeconds: 30, factual: false },
  scenes: [
    {
      id: "one",
      startSeconds: 0,
      durationSeconds: 30,
      characterRefs: [],
      dialogue: "",
      narration: "Leaves reveal other pigments when chlorophyll fades.",
      visualDescription: "Autumn tree",
      camera: "wide",
      audioCues: [],
    },
  ],
};
const capability: ScriptLlmPort["capability"] = {
  providerId: "offline-script",
  capabilityId: "llm",
  kind: "llm",
  input: ["text"],
  output: ["json"],
  supportsReferenceImages: false,
  asynchronous: false,
  polling: false,
  regions: [],
  costModel: { amount: 0.01, currency: "USD", unit: "request" },
};
const complete = vi.fn<ScriptLlmPort["complete"]>(async () => ({
  output: document,
  metadata: {
    modelVersion: "offline-v1",
    promptVersion: "v1.scriptwriter",
    cost: 0.01,
    currency: "USD",
  },
}));

describe.skipIf(!url)("Wave 0 fresh installation HTTP E2E (offline providers)", () => {
  const db = createDatabaseClient(url ?? "postgresql://unused");
  let app: INestApplication,
    workspaceId = "",
    userId = "",
    channelId = "",
    cookie: string[] = [];
  let input: Record<string, unknown> = {};
  beforeAll(async () => {
    const registry = new ProviderRegistry();
    registry.register({
      capability,
      credential: {
        providerId: capability.providerId,
        environment: "development",
        secret: "offline-only",
      },
    });
    const module = await Test.createTestingModule({
      imports: [ScriptModule, IdeaModule, ChannelModule, ConfigModule],
    })
      .overrideProvider("DATABASE")
      .useValue(db)
      .overrideProvider(SCRIPT_LLM)
      .useValue({ capability, complete })
      .overrideProvider(PROVIDER_REGISTRY)
      .useValue(registry)
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    if (workspaceId) await db.scriptRevision.deleteMany({ where: { workspaceId } });
    if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
    if (userId) await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  });
  it("registers, creates workspace/channel/idea and generates a script without manual DB writes", async () => {
    const http = app.getHttpServer() as never;
    const auth = await request(http)
      .post("/auth/register")
      .send({ email: `${randomUUID()}@wave0.invalid`, password: "offline-test-password-123" })
      .expect(201);
    userId = String(auth.body.userId);
    cookie = auth.headers["set-cookie"] as unknown as string[];
    const workspace = await request(http)
      .post("/workspaces")
      .set("Cookie", cookie)
      .send({ name: "Fresh Wave 0" })
      .expect(201);
    workspaceId = String(workspace.body.id);
    const base = `/workspaces/${workspaceId}`;
    const channel = await request(http)
      .post(`${base}/channels`)
      .set("Cookie", cookie)
      .send({
        name: "Science",
        timezone: "Asia/Kolkata",
        narratorVoice: { providerId: "fixture", voiceId: "narrator", language: "English" },
      })
      .expect(201);
    channelId = String(channel.body.id);
    expect(channel.body).toMatchObject({
      schedule: { shortsPerDay: 1, localTime: "18:00" },
      automationDefaults: { autonomy: "L2", aiDisclosure: true },
      timezone: "Asia/Kolkata",
    });
    const idea = await request(http)
      .post(`${base}/ideas`)
      .set("Cookie", cookie)
      .send({
        channelId,
        title: "Autumn leaves",
        topic: "Leaf pigments",
        hook: "Why do leaves change color?",
        angle: "Science",
        audience: "Everyone",
        expectedFormat: "explainer",
      })
      .expect(201);
    await request(http)
      .patch(`${base}/ideas/${String(idea.body.id)}/status`)
      .set("Cookie", cookie)
      .send({
        status: "APPROVED",
        expectedStatus: idea.body.status,
        expectedUpdatedAt: idea.body.updatedAt,
      })
      .expect(200);
    const approved = await request(http)
      .get(`${base}/ideas/approved/${String(idea.body.id)}`)
      .set("Cookie", cookie)
      .expect(200);
    const configs = await request(http)
      .get(`${base}/config/generation-snapshots`)
      .set("Cookie", cookie)
      .expect(200);
    const bundles = await request(http)
      .get(`${base}/prompts/bundle-snapshots`)
      .set("Cookie", cookie)
      .expect(200);
    expect(configs.body).toHaveLength(1);
    expect(bundles.body).toHaveLength(9);
    input = {
      approvedIdeaSnapshotId: approved.body.id,
      approvedIdeaChecksum: approved.body.checksumSha256,
      channelId,
      configSnapshotId: configs.body[0].id,
      promptSnapshotId: bundles.body[0].id,
      prompt: "Generate a 30 second explainer",
    };
    const script = await request(http).post(`${base}/scripts`).set("Cookie", cookie).send(input);
    expect(script.status, JSON.stringify(script.body)).toBe(201);
    expect(script.body.revisions[0].document).toEqual(document);
    expect(complete).toHaveBeenCalledOnce();
  });
  it.each([
    { hook: "" },
    { hook: Array(21).fill("word").join(" ") },
    { cta: " " },
    { cta: Array(16).fill("word").join(" ") },
  ])("rejects malformed supplied copy before paid text dispatch: %j", async (copy) => {
    const before = complete.mock.calls.length;
    await request(app.getHttpServer() as never)
      .post(`/workspaces/${workspaceId}/scripts`)
      .set("Cookie", cookie)
      .send({ ...input, ...copy })
      .expect(400);
    expect(complete).toHaveBeenCalledTimes(before);
  });
  it("seed bundle fingerprints match the M05 compiler and rerunning the seed changes nothing", async () => {
    const before = await db.promptBundleSnapshot.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
      include: { template: true, templateVersion: true, configSnapshot: true },
    });
    await seedWorkspaceFoundations(db, workspaceId);
    const after = await db.promptBundleSnapshot.findMany({
      where: { workspaceId },
      orderBy: { id: "asc" },
      include: { template: true, templateVersion: true, configSnapshot: true },
    });
    expect(after).toEqual(before);
    const resolved = resolveConfig({ layers: [] });
    expect(after[0]?.configSnapshot).toMatchObject({
      fingerprintSha256: resolved.configSha256,
      resolutionSha256: resolved.resolutionSha256,
      layers: [...resolved.layers],
      lockedFields: [...resolved.lockedFields],
    });
    for (const row of after) {
      const compiled = compilePrompt({
        config: CreativeConfigSchema.parse(row.configSnapshot.config),
        template: {
          templateId: row.templateId,
          templateKey: row.template.key,
          templateName: row.template.name,
          versionId: row.templateVersionId,
          version: row.templateVersion.version,
          checksumSha256: row.templateVersion.checksumSha256,
          body: parsePromptTemplateBody(row.templateVersion.body),
        },
      });
      expect(row.fingerprintSha256).toBe(compiled.fingerprintSha256);
    }
  });
});
