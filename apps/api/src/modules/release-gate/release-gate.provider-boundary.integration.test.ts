import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { IMAGE_PROVIDER, TTS_PROVIDER, VIDEO_PROVIDER } from "@reelforge/ai-providers";
import { createDatabaseClient } from "@reelforge/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../app.module.js";
import { ProvidersRuntime } from "../openai/providers.runtime.js";
import { planningFixture, shotsFixture } from "../script/planning.fixture.js";
import { AuditService } from "../admin/audit.service.js";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { NOTIFICATION_EMAIL_PORT } from "../notifications/notifications.ports.js";
import { INSIGHT_REPORT_LLM } from "../performance-intelligence/performance-intelligence.tokens.js";
import { BILLING_PROVIDER } from "../usage-budget/usage-budget.types.js";

/**
 * M20-T04 / acceptance "no unverified fake/test integration is presented as a working feature".
 *
 * Boots the real `AppModule` with its default runtime bindings (no provider overrides except the
 * NOT_CONFIGURED workflow queue) and proves that every external provider boundary fails clearly
 * instead of returning a fake success, that no paid call is recorded or charged, and that no
 * network call is attempted. Offline only (ADR-007/ADR-010). The workspace, user and session rows
 * below are clearly marked test fixtures, not product data.
 */
/**
 * Test-seam audit sink. The real M19 `HttpAuditInterceptor` still runs, but its entries are kept in
 * memory instead of the shared `audit_events` table, because that table is append-only and other
 * suites read it by time window; writing hundreds of denied sweep rows there would bleed into them.
 */
class CapturingAuditService {
  public readonly entries: Array<Readonly<Record<string, unknown>>> = [];
  public record(entry: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.entries.push(entry);
    return Promise.resolve({ ...entry, id: randomUUID() });
  }
  public list(): Promise<unknown> {
    return Promise.resolve({ items: [], nextBefore: null });
  }
}

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const ownerId = randomUUID();
const workspaceId = randomUUID();
const channelId = randomUUID();

type AnyPort = Record<string, unknown>;

async function rejects(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error("M20 provider boundary returned a result instead of failing clearly");
}

suite("M20 release gate: provider boundaries fail clearly with no charge and no network", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  const previousLogLevel = process.env["LOG_LEVEL"];
  let app: INestApplication | undefined;
  let token = "";
  const auditSink = new CapturingAuditService();
  const fetchSpy = vi.fn(async (): Promise<Response> => {
    throw new Error("M20 release gate: live network call attempted");
  });
  const port = <T = AnyPort>(key: unknown): T =>
    app!.get(key as string, { strict: false }) as unknown as T;

  beforeAll(async () => {
    if (!db) return;
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@m20-boundary.invalid` } });
    await db.workspace.create({ data: { id: workspaceId, name: "m20-boundary-fixture" } });
    await db.workspaceMembership.create({ data: { workspaceId, userId: ownerId, role: "OWNER" } });
    await db.channel.create({
      data: { id: channelId, workspaceId, name: "m20-boundary-fixture-channel" },
    });
    token = randomUUID();
    await db.session.create({
      data: {
        userId: ownerId,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    vi.stubGlobal("fetch", fetchSpy);
    for (const model of [
      "GEMINI_VIDEO_MODEL",
      "GEMINI_IMAGE_MODEL",
      "GEMINI_TEXT_MODEL",
      "GEMINI_TTS_MODEL",
      "GEMINI_MUSIC_MODEL",
      "XAI_VIDEO_MODEL",
    ])
      vi.stubEnv(model, "boundary-fixture-model");
    process.env["LOG_LEVEL"] = "fatal";
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider("DATABASE")
      .useValue(db)
      .overrideProvider(AuditService)
      .useValue(auditSink)
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (previousLogLevel === undefined) delete process.env["LOG_LEVEL"];
    else process.env["LOG_LEVEL"] = previousLogLevel;
    if (!db) return;
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  it("rejects retired media tokens and unconfigured VideoRun AI dispatch without network or charge", async () => {
    if (!db) return;

    for (const retired of [IMAGE_PROVIDER, VIDEO_PROVIDER, TTS_PROVIDER])
      expect(() => port(retired)).toThrow();
    const context = { workspaceId, userId: ownerId, role: "OWNER" as const };
    const runtime = port<ProvidersRuntime>(ProvidersRuntime);
    const native = await runtime.ports(context, { resolve: async (): Promise<never[]> => [] });
    const shot = { ...shotsFixture(planningFixture())[0]!, workspaceId, durationSeconds: 5 };
    for (const video of [native.omni, native.grok]) {
      expect(video.capabilities()).toMatchObject({ health: "NOT_CONFIGURED" });
      expect(["gemini", "xai"]).toContain(video.capabilities().providerId);
      await expect(video.submit(shot, randomUUID())).rejects.toMatchObject({
        kind: "NOT_CONFIGURED",
        dispatched: false,
      });
    }
    for (const call of [
      (): ReturnType<typeof native.image.submit> =>
        native.image.submit({ prompt: "Boundary fixture", references: [] }, randomUUID()),
      (): ReturnType<typeof native.tts.submit> =>
        native.tts.submit({ text: "Boundary fixture", voice: "fixture" }, randomUUID()),
      (): ReturnType<typeof native.music.submit> =>
        native.music.submit(
          { prompt: "Boundary fixture", instrumentalOnly: true, durationSeconds: 30 },
          randomUUID(),
        ),
      (): Promise<unknown> =>
        native.text.complete(
          { prompt: "Boundary fixture", jsonSchema: {}, parse: (value): unknown => value },
          randomUUID(),
        ),
    ])
      await expect(call()).rejects.toMatchObject({ kind: "NOT_CONFIGURED", dispatched: false });
    expect(await db.providerRequest.count({ where: { workspaceId } })).toBe(0);
    expect(await db.usageReservation.count({ where: { workspaceId } })).toBe(0);
    const insight = port(INSIGHT_REPORT_LLM);
    expect((insight["isConfigured"] as () => boolean)()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("binds NOT_CONFIGURED email, billing and Instagram boundaries (M12, M17, M18)", async () => {
    if (!db) return;
    const email = port(NOTIFICATION_EMAIL_PORT);
    expect((email["isConfigured"] as () => boolean)()).toBe(false);
    const emailError = (await rejects(() => (email["send"] as () => unknown)())) as {
      code?: string;
    };
    expect(emailError.code).toBe("EMAIL_NOT_CONFIGURED");

    const billing = port(BILLING_PROVIDER);
    expect(billing["status"]).toBe("NOT_CONFIGURED");
    await rejects(() => (billing["reportUsage"] as () => unknown)());

    const instagram = port("INSTAGRAM_CONNECTOR");
    expect((instagram["isConfigured"] as () => boolean)()).toBe(false);
    await rejects(() => (instagram["authorizationUrl"] as () => unknown)());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
