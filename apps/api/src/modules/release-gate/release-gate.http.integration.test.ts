import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { RequestMethod } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { eventRegistry, parseRegisteredEvent } from "@reelforge/contracts";
import { createDatabaseClient } from "@reelforge/database";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../app.module.js";
import { AuditService } from "../admin/audit.service.js";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { NotificationIntakeSources } from "../notifications/notifications.sources.js";
import { NotConfiguredWorkflowQueue } from "../orchestration/orchestration.queue.js";
import { WORKFLOW_QUEUE_PORT } from "../orchestration/orchestration.types.js";

/**
 * M20 release gate (T02 cross-module contracts, T06 tenant isolation and no-live-call checks).
 *
 * This is an offline, fixture-only integration check (ADR-007/ADR-010). It boots the real
 * `AppModule` against a disposable PostgreSQL database and never reaches a provider: `fetch` is
 * replaced by a spy that throws, and the workflow queue is the NOT_CONFIGURED adapter. Passing it
 * proves local authorization and contract behaviour only, not live provider integration.
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

// Full-suite Postgres/HTTP work needs headroom on constrained development machines.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const PREFIX = "/api/v1";

const victimOwnerId = randomUUID();
const attackerId = randomUUID();
const victimWorkspaceId = randomUUID();
const attackerWorkspaceId = randomUUID();
const victimChannelId = randomUUID();
const attackerChannelId = randomUUID();

/** Routes reviewed in M20 INTEGRATION_REVIEW.md as intentionally outside a workspace scope. */
const REVIEWED_UNSCOPED_ROUTES: readonly string[] = [
  "GET /auth/csrf",
  "GET /auth/me",
  "GET /health",
  "GET /ops/metrics",
  "GET /social-accounts/oauth/:platform/callback",
  "GET /workspaces",
  "PATCH /auth/me",
  "POST /auth/login",
  "POST /auth/logout",
  "POST /auth/me/password",
  "POST /auth/register",
  "POST /workspaces",
];

type RouteInfo = Readonly<{ method: string; path: string; handler: string }>;

const METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
};

function joinPath(base: string, sub: string): string {
  const parts = [base, sub].map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  return `/${parts.join("/")}`;
}

/** Every routed controller handler in the booted application, from Nest metadata. */
function collectRoutes(app: INestApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
      if (!type) continue;
      const basePaths = [Reflect.getMetadata("path", type) as string | string[] | undefined]
        .flat()
        .map((path) => path ?? "");
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        const handler = (type.prototype as Record<string, unknown>)[name];
        if (name === "constructor" || typeof handler !== "function") continue;
        const subPaths = Reflect.getMetadata("path", handler) as string | string[] | undefined;
        if (subPaths === undefined) continue;
        const method = METHOD_NAMES[Reflect.getMetadata("method", handler) as RequestMethod];
        if (method === undefined) continue;
        for (const base of basePaths) {
          for (const sub of [subPaths].flat()) {
            routes.push({ method, path: joinPath(base, sub), handler: `${type.name}.${name}` });
          }
        }
      }
    }
  }
  return routes;
}

function concretePath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    if (name === "workspaceId") return victimWorkspaceId;
    if (name === "channelId") return victimChannelId;
    // Integer path params (for example `:version`) get a valid integer so the request reaches
    // the tenant check instead of stopping at parameter parsing.
    if (/version|revision/i.test(name)) return "1";
    return randomUUID();
  });
}

async function session(
  db: ReturnType<typeof createDatabaseClient>,
  userId: string,
): Promise<string> {
  const token = randomUUID();
  await db.session.create({
    data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 600_000) },
  });
  return token;
}

suite("M20 release gate: tenant isolation, no live calls, and event contracts over HTTP", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  let app: INestApplication | undefined;
  let victimToken = "";
  let attackerToken = "";
  const auditSink = new CapturingAuditService();
  const previousLogLevel = process.env["LOG_LEVEL"];
  const fetchSpy = vi.fn(async (): Promise<Response> => {
    throw new Error("M20 release gate: live network call attempted");
  });

  const server = (): never => app!.getHttpServer() as never;

  beforeAll(async () => {
    if (!db) return;
    await db.user.createMany({
      data: [victimOwnerId, attackerId].map((id) => ({ id, email: `${id}@m20-gate.invalid` })),
    });
    await db.workspace.createMany({
      data: [
        { id: victimWorkspaceId, name: "m20-gate-victim" },
        { id: attackerWorkspaceId, name: "m20-gate-attacker" },
      ],
    });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId: victimWorkspaceId, userId: victimOwnerId, role: "OWNER" },
        { workspaceId: attackerWorkspaceId, userId: attackerId, role: "OWNER" },
      ],
    });
    await db.channel.createMany({
      data: [
        { id: victimChannelId, workspaceId: victimWorkspaceId, name: "m20-gate-victim-channel" },
        { id: attackerChannelId, workspaceId: attackerWorkspaceId, name: "m20-gate-attacker" },
      ],
    });
    victimToken = await session(db, victimOwnerId);
    attackerToken = await session(db, attackerId);
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
    if (previousLogLevel === undefined) delete process.env["LOG_LEVEL"];
    else process.env["LOG_LEVEL"] = previousLogLevel;
    if (!db) return;
    await db.outboxEvent.deleteMany({
      where: { workspaceId: { in: [victimWorkspaceId, attackerWorkspaceId] } },
    });
    await db.workspace.deleteMany({
      where: { id: { in: [victimWorkspaceId, attackerWorkspaceId] } },
    });
    await db.user.deleteMany({ where: { id: { in: [victimOwnerId, attackerId] } } });
    await db.$disconnect();
  });

  it("denies valid cross-tenant mutations before validation or writes (T06)", async () => {
    if (!db) return;
    const beforeChannels = await db.channel.count({ where: { workspaceId: victimWorkspaceId } });
    const beforeVictim = await db.channel.findUnique({ where: { id: victimChannelId } });

    await request(server())
      .post(`${PREFIX}/workspaces/${victimWorkspaceId}/channels`)
      .set("authorization", `Bearer ${attackerToken}`)
      .send({ name: "cross-tenant-valid-create", description: "valid fixture payload" })
      .expect(403);
    await request(server())
      .patch(`${PREFIX}/workspaces/${victimWorkspaceId}/channels/${victimChannelId}`)
      .set("authorization", `Bearer ${attackerToken}`)
      .send({ name: "cross-tenant-valid-update" })
      .expect(403);

    expect(await db.channel.count({ where: { workspaceId: victimWorkspaceId } })).toBe(
      beforeChannels,
    );
    expect(await db.channel.findUnique({ where: { id: victimChannelId } })).toMatchObject({
      name: beforeVictim?.name,
      description: beforeVictim?.description,
    });
  });

  it("checks every workspace-scoped route for cross-tenant access (T06)", async () => {
    if (!db) return;
    const routes = collectRoutes(app!).filter((route) => route.path.includes(":workspaceId"));
    // Guard against a silently empty sweep: M01–M19 register well over 60 workspace routes.
    expect(routes.length).toBeGreaterThan(60);
    const leaks: string[] = [];
    for (const route of routes) {
      const url = `${PREFIX}${concretePath(route.path)}`;
      const call = request(server())
        [route.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch"](url)
        .set("authorization", `Bearer ${attackerToken}`);
      const response =
        route.method === "GET" || route.method === "DELETE" ? await call : await call.send({});
      const status = response.status;
      const allowed = route.method === "GET" ? [403, 404] : [400, 403, 404, 409, 422];
      if (!allowed.includes(status)) leaks.push(`${route.method} ${route.path} -> ${status}`);
    }
    expect(leaks).toEqual([]);
    console.info(`M20 tenant sweep: ${routes.length} workspace-scoped routes checked`);
    // The sweep wrote nothing into the victim tenant and called no provider or platform.
    expect(await db.channel.count({ where: { workspaceId: victimWorkspaceId } })).toBe(1);
    expect(await db.workflowRun.count({ where: { workspaceId: victimWorkspaceId } })).toBe(0);
    expect(await db.providerRequest.count({ where: { workspaceId: victimWorkspaceId } })).toBe(0);
    // The real audit interceptor saw the attacker's requests and recorded none as a success.
    const attackerEntries = auditSink.entries.filter(
      (entry) => entry["actorUserId"] === attackerId,
    );
    expect(attackerEntries.length).toBeGreaterThan(0);
    expect(attackerEntries.filter((entry) => entry["outcome"] === "SUCCESS")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects every workspace-scoped route without a session (401) (T06)", async () => {
    if (!db) return;
    const routes = collectRoutes(app!).filter((route) => route.path.includes(":workspaceId"));
    const wrong: string[] = [];
    for (const route of routes) {
      const url = `${PREFIX}${concretePath(route.path)}`;
      const response =
        await request(server())[
          route.method.toLowerCase() as "get" | "post" | "put" | "delete" | "patch"
        ](url);
      if (response.status !== 401)
        wrong.push(`${route.method} ${route.path} -> ${response.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it("exposes only the reviewed routes outside a workspace scope (T06 route inventory)", async () => {
    if (!db) return;
    const unscoped = collectRoutes(app!)
      .filter((route) => !route.path.includes(":workspaceId"))
      .map((route) => `${route.method} ${route.path}`)
      .sort();
    // A new route outside `/workspaces/:workspaceId` must be reviewed and added here on purpose.
    expect(unscoped).toEqual(REVIEWED_UNSCOPED_ROUTES);
    // C5 account routes are user-scoped and require the existing auth guard.
    await request(server()).get(`${PREFIX}/auth/me`).expect(401);
    await request(server()).patch(`${PREFIX}/auth/me`).send({ displayName: "Creator" }).expect(401);
    await request(server()).post(`${PREFIX}/auth/me/password`).send({}).expect(401);
    // The two member-facing unscoped routes still require a session.
    await request(server()).get(`${PREFIX}/workspaces`).expect(401);
    await request(server()).post(`${PREFIX}/workspaces`).send({ name: "m20-gate" }).expect(401);
    // The operator metrics route is hidden (404) when OPS_METRICS_TOKEN is unset (ADR-019).
    if (process.env["OPS_METRICS_TOKEN"] === undefined)
      await request(server()).get(`${PREFIX}/ops/metrics`).expect(404);
  });

  it("lets the victim OWNER read its own tenant on a sample of module routes (sweep sanity)", async () => {
    if (!db) return;
    const auth = { authorization: `Bearer ${victimToken}` };
    await request(server())
      .get(`${PREFIX}/workspaces/${victimWorkspaceId}/channels`)
      .set(auth)
      .expect(200);
    await request(server())
      .get(`${PREFIX}/workspaces/${victimWorkspaceId}/admin/emergency-stop`)
      .set(auth)
      .expect(200);
    await request(server())
      .get(`${PREFIX}/workspaces/${victimWorkspaceId}/channels`)
      .set({ authorization: `Bearer ${attackerToken}` })
      .expect((response) => expect([403, 404]).toContain(response.status));
  });

  it("delivers every registered M13 outbox event to M17 intake with a payload valid at both ends (T02)", async () => {
    if (!db) return;
    const now = new Date();
    const postId = randomUUID();
    const events = [
      {
        eventId: randomUUID(),
        eventType: "PostPublished",
        eventVersion: 1,
        occurredAt: now.toISOString(),
        workspaceId: victimWorkspaceId,
        channelId: victimChannelId,
        correlationId: randomUUID(),
        idempotencyKey: `m20-gate-post-published:${postId}`,
        aggregateType: "publishing_destination",
        aggregateId: randomUUID(),
        payload: { postId, platform: "YOUTUBE", platformPostId: "fixture-video-id" },
      },
      {
        eventId: randomUUID(),
        eventType: "PublishFailed",
        eventVersion: 1,
        occurredAt: now.toISOString(),
        workspaceId: victimWorkspaceId,
        channelId: victimChannelId,
        correlationId: randomUUID(),
        idempotencyKey: `m20-gate-publish-failed:${postId}`,
        aggregateType: "publishing_destination",
        aggregateId: randomUUID(),
        payload: { postId, failureCode: "YOUTUBE_PROCESSING_FAILED", retryable: false },
      },
    ];
    // Producer side: the registry covers exactly these two M13 events and both parse.
    expect(Object.keys(eventRegistry).sort()).toEqual(["PostPublished@1", "PublishFailed@1"]);
    for (const event of events) {
      const parsed = parseRegisteredEvent(event);
      await db.outboxEvent.create({
        data: {
          id: parsed.eventId,
          workspaceId: parsed.workspaceId,
          eventType: parsed.eventType,
          eventVersion: parsed.eventVersion,
          occurredAt: now,
          channelId: parsed.channelId ?? null,
          correlationId: parsed.correlationId,
          aggregateType: parsed.aggregateType,
          aggregateId: parsed.aggregateId,
          idempotencyKey: parsed.idempotencyKey,
          payload: parsed.payload,
        },
      });
    }
    // Consumer side: the persisted rows still validate against the registry...
    const rows = await db.outboxEvent.findMany({ where: { workspaceId: victimWorkspaceId } });
    for (const row of rows) {
      expect(() =>
        parseRegisteredEvent({
          eventId: row.id,
          eventType: row.eventType,
          eventVersion: row.eventVersion,
          occurredAt: row.occurredAt.toISOString(),
          workspaceId: row.workspaceId,
          channelId: row.channelId ?? undefined,
          correlationId: row.correlationId,
          causationId: row.causationId ?? undefined,
          idempotencyKey: row.idempotencyKey,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          payload: row.payload,
        }),
      ).not.toThrow();
    }
    // ...and M17's outbox intake maps each registered type to a notification for that tenant.
    const source = app!
      .get(NotificationIntakeSources)
      .all()
      .find((candidate) => candidate.key === "m13.outbox");
    expect(source).toBeDefined();
    const items = await source!.read(
      { at: new Date(now.getTime() - 1), id: "00000000-0000-0000-0000-000000000000" },
      new Date(now.getTime() + 1_000),
      1_000,
    );
    const mine = items
      .map((item) => item.event)
      .filter((event) => event !== null && event.workspaceId === victimWorkspaceId);
    expect(mine.map((event) => event!.eventType).sort()).toEqual([
      "PUBLISH_FAILED",
      "PUBLISH_SUCCEEDED",
    ]);
    expect(mine.every((event) => event!.channelId === victimChannelId)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
