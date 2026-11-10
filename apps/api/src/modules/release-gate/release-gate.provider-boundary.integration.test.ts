import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  IDEA_PROPOSAL_LLM,
  IMAGE_PROVIDER,
  PROVIDER_REGISTRY,
  ProviderRegistry,
  QUALITY_REVIEW_PORT,
  SCRIPT_LLM,
  TTS_PROVIDER,
  VIDEO_PROVIDER,
} from "@reelforge/ai-providers";
import { createDatabaseClient } from "@reelforge/database";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../app.module.js";
import { AuditService } from "../admin/audit.service.js";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { NOTIFICATION_EMAIL_PORT } from "../notifications/notifications.ports.js";
import { NotConfiguredWorkflowQueue } from "../orchestration/orchestration.queue.js";
import { WORKFLOW_QUEUE_PORT } from "../orchestration/orchestration.types.js";
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
const PREFIX = "/api/v1";
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
    process.env["LOG_LEVEL"] = "fatal";
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider("DATABASE")
      .useValue(db)
      .overrideProvider(WORKFLOW_QUEUE_PORT)
      .useValue(new NotConfiguredWorkflowQueue())
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
    delete process.env["LOG_LEVEL"];
    if (!db) return;
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.user.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  it("binds only NOT_CONFIGURED AI adapters, each failing with no cost model (M06–M09, M11, M15)", async () => {
    if (!db) return;
    const registry = port<ProviderRegistry>(PROVIDER_REGISTRY);
    expect(registry).toBeInstanceOf(ProviderRegistry);
    expect(registry.list()).toEqual([]);

    const media = [IMAGE_PROVIDER, VIDEO_PROVIDER, TTS_PROVIDER].map((key) => port(key));
    for (const adapter of [port(SCRIPT_LLM), ...media, port(INSIGHT_REPORT_LLM)]) {
      const capability = adapter["capability"] as {
        providerId: string;
        capabilityId: string;
        costModel: { amount: number | null };
      };
      expect(capability.providerId).toBe("unconfigured");
      // A null cost model means the M08/M18 budget preflight can never dispatch a paid call.
      expect(capability.costModel.amount).toBeNull();
      // The registry has nothing registered, so readiness fails before any reservation.
      expect(() => registry.assertReady(capability as never, "development")).toThrow();
    }

    const script = port(SCRIPT_LLM);
    expect(await rejects(() => (script["complete"] as () => unknown)())).toBeInstanceOf(Error);
    for (const [adapter, method] of [
      [media[0], "generate"],
      [media[1], "generate"],
      [media[2], "synthesize"],
    ] as const) {
      const error = (await rejects(() => (adapter![method] as () => unknown)())) as {
        code?: string;
      };
      expect(error.code).toBe("NOT_CONFIGURED");
    }
    const idea = port(IDEA_PROPOSAL_LLM);
    expect(await rejects(() => (idea["proposeIdea"] as () => unknown)())).toBeInstanceOf(Error);
    const quality = port(QUALITY_REVIEW_PORT);
    const qualityError = (await rejects(() =>
      (quality["review"] as (input: unknown) => unknown)({ correlationId: randomUUID() }),
    )) as { code?: string };
    expect(qualityError.code).toBe("NOT_CONFIGURED");
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

  it("refuses an AI idea proposal over HTTP without creating data, a ledger row or a charge (T04)", async () => {
    if (!db) return;
    const response = await request(app!.getHttpServer() as never)
      .post(`${PREFIX}/workspaces/${workspaceId}/ideas/propose`)
      .set("authorization", `Bearer ${token}`)
      .send({ prompt: "M20 fixture prompt: offline boundary check only", channelId });
    // The unconfigured adapter must never produce a 2xx (no fake success).
    expect(response.status).toBeGreaterThanOrEqual(400);
    console.info(`M20 provider boundary: idea propose -> HTTP ${response.status}`);
    expect(await db.idea.count({ where: { workspaceId } })).toBe(0);
    expect(await db.providerRequest.count({ where: { workspaceId } })).toBe(0);
    expect(await db.usageReservation.count({ where: { workspaceId } })).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
