import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { createDatabaseClient } from "@reelforge/database";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../../app.module.js";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { NotConfiguredWorkflowQueue } from "../orchestration/orchestration.queue.js";
import { WORKFLOW_QUEUE_PORT } from "../orchestration/orchestration.types.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);

const ownerId = randomUUID();
const editorId = randomUUID();
const viewerId = randomUUID();
const outsiderId = randomUUID();
const workspaceId = randomUUID();
const foreignWorkspaceId = randomUUID();
const channelId = randomUUID();
const foreignChannelId = randomUUID();
const failedRunId = randomUUID();
const foreignRunId = randomUUID();
const registerEmail = `m19-${randomUUID()}@http.invalid`;
const SECRET_PASSWORD = "Sup3r-Secret-Passw0rd!";
const PREFIX = "/api/v1";

/**
 * Records every model/raw call the application makes through the injected Prisma client, so the
 * health test can prove which database work a probe does (and that nothing else, such as a
 * provider ledger row or a usage reservation, is written), independent of other parallel suites.
 */
function recordingClient<T extends object>(client: T, calls: string[]): T {
  return new Proxy(client, {
    get(target, prop, receiver): unknown {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") return value;
      if (typeof value === "function") {
        return (...args: unknown[]): unknown => {
          calls.push(prop);
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      if (
        value !== null &&
        typeof value === "object" &&
        !prop.startsWith("_") &&
        !prop.startsWith("$")
      ) {
        return new Proxy(value, {
          get(delegate, method): unknown {
            const fn: unknown = Reflect.get(delegate, method);
            if (typeof fn !== "function") return fn;
            return (...args: unknown[]): unknown => {
              calls.push(`${prop}.${String(method)}`);
              return (fn as (...inner: unknown[]) => unknown).apply(delegate, args);
            };
          },
        });
      }
      return value;
    },
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

suite("M19 admin, audit, health and correlation over HTTP (T01-T06)", () => {
  const db = databaseUrl === undefined ? undefined : createDatabaseClient(databaseUrl);
  let app: INestApplication | undefined;
  const tokens: Record<"owner" | "editor" | "viewer" | "outsider", string> = {
    owner: "",
    editor: "",
    viewer: "",
    outsider: "",
  };
  let registeredUserId = "";
  const dbCalls: string[] = [];

  const server = (): never => app!.getHttpServer() as never;
  const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
  const audits = async (
    since: Date,
  ): Promise<NonNullable<Awaited<ReturnType<NonNullable<typeof db>["auditEvent"]["findMany"]>>>> =>
    db!.auditEvent.findMany({
      where: { occurredAt: { gte: since } },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });

  beforeAll(async () => {
    if (!db) return;
    await db.user.createMany({
      data: [ownerId, editorId, viewerId, outsiderId].map((id) => ({
        id,
        email: `${id}@m19-http.invalid`,
      })),
    });
    await db.workspace.createMany({
      data: [
        { id: workspaceId, name: "m19-http" },
        { id: foreignWorkspaceId, name: "m19-http-foreign" },
      ],
    });
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: ownerId, role: "OWNER" },
        { workspaceId, userId: editorId, role: "EDITOR" },
        { workspaceId, userId: viewerId, role: "VIEWER" },
        { workspaceId: foreignWorkspaceId, userId: outsiderId, role: "OWNER" },
      ],
    });
    await db.channel.createMany({
      data: [
        { id: channelId, workspaceId, name: "m19-http-channel" },
        { id: foreignChannelId, workspaceId: foreignWorkspaceId, name: "m19-http-foreign-channel" },
      ],
    });
    await db.workflowRun.createMany({
      data: [
        {
          id: failedRunId,
          workspaceId,
          channelId,
          correlationId: randomUUID(),
          idempotencyKey: `m19-${failedRunId}`,
          state: "FAILED",
          lastErrorCode: "PROVIDER_FAILED",
          lastErrorMessage:
            "upload failed for https://storage.example.test/bucket/key?X-Goog-Signature=abcdef0123 with Bearer ya29.secret-token",
        },
        {
          id: foreignRunId,
          workspaceId: foreignWorkspaceId,
          channelId: foreignChannelId,
          correlationId: randomUUID(),
          idempotencyKey: `m19-${foreignRunId}`,
          state: "FAILED",
          lastErrorCode: "FOREIGN",
        },
      ],
    });
    tokens.owner = await session(db, ownerId);
    tokens.editor = await session(db, editorId);
    tokens.viewer = await session(db, viewerId);
    tokens.outsider = await session(db, outsiderId);
    process.env["LOG_LEVEL"] = "warn";
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider("DATABASE")
      .useValue(recordingClient(db, dbCalls))
      .overrideProvider(WORKFLOW_QUEUE_PORT)
      .useValue(new NotConfiguredWorkflowQueue())
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    delete process.env["LOG_LEVEL"];
    if (!db) return;
    await db.workspace.deleteMany({ where: { id: { in: [workspaceId, foreignWorkspaceId] } } });
    await db.user.deleteMany({ where: { id: { in: [ownerId, editorId, viewerId, outsiderId] } } });
    if (registeredUserId) {
      await db.workspace.deleteMany({
        where: { memberships: { some: { userId: registeredUserId } } },
      });
      await db.user.deleteMany({ where: { id: registeredUserId } });
    }
    await db.$disconnect();
  });

  it("guards every route except the documented public allowlist (T01 baseline)", () => {
    const unguarded: string[] = [];
    for (const module of app!.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const type = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
        if (!type) continue;
        const classGuards =
          (Reflect.getMetadata("__guards__", type) as unknown[] | undefined) ?? [];
        for (const name of Object.getOwnPropertyNames(type.prototype)) {
          const handler = (type.prototype as Record<string, unknown>)[name];
          if (name === "constructor" || typeof handler !== "function") continue;
          if (Reflect.getMetadata("path", handler) === undefined) continue;
          const methodGuards =
            (Reflect.getMetadata("__guards__", handler) as unknown[] | undefined) ?? [];
          if (classGuards.length + methodGuards.length === 0)
            unguarded.push(`${type.name}.${name}`);
        }
      }
    }
    expect(unguarded.sort()).toEqual(PUBLIC_ROUTES);
  });

  it("serves /health without provider calls or charges, with liveness and readiness probes", async () => {
    if (!db) return;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    dbCalls.length = 0;
    const health = await request(server()).get(`${PREFIX}/health`).expect(200);
    expect(health.body).toEqual({ status: "ok", queue: "NOT_CONFIGURED", database: "OK" });
    await request(server())
      .get(`${PREFIX}/health?probe=liveness`)
      .expect(200, { status: "ok", probe: "liveness" });
    await request(server())
      .get(`${PREFIX}/health?probe=readiness`)
      .expect(200)
      .expect((response) => expect(response.body).toMatchObject({ status: "ok", database: "OK" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    // The only database work across the three probes is the two readiness `SELECT 1` checks
    // (plain /health and ?probe=readiness); liveness touches nothing. No ledger or usage writes.
    expect(dbCalls).toEqual(["$queryRaw", "$queryRaw"]);
    fetchSpy.mockRestore();
  });

  it("echoes a valid correlation id, replaces an invalid one, and emits a traceparent", async () => {
    const correlationId = randomUUID();
    const echoed = await request(server())
      .get(`${PREFIX}/health`)
      .set("x-correlation-id", correlationId);
    expect(echoed.headers["x-correlation-id"]).toBe(correlationId);
    expect(echoed.headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const replaced = await request(server())
      .get(`${PREFIX}/health`)
      .set("x-correlation-id", "drop table;--");
    expect(replaced.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(replaced.headers["x-correlation-id"]).not.toBe("drop table;--");
    const parent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const traced = await request(server()).get(`${PREFIX}/health`).set("traceparent", parent);
    expect(traced.headers["traceparent"]).toMatch(
      /^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/,
    );
  });

  it("audits auth success, failure and logout without storing credentials", async () => {
    if (!db) return;
    const since = new Date();
    const correlationId = randomUUID();
    const registered = await request(server())
      .post(`${PREFIX}/auth/register`)
      .set("x-correlation-id", correlationId)
      .send({ email: registerEmail, password: SECRET_PASSWORD, displayName: "M19" })
      .expect(201);
    registeredUserId = (registered.body as { userId: string }).userId;
    await request(server())
      .post(`${PREFIX}/auth/login`)
      .send({ email: registerEmail, password: "wrong-password-123!" })
      .expect(401);
    const login = await request(server())
      .post(`${PREFIX}/auth/login`)
      .send({ email: registerEmail, password: SECRET_PASSWORD })
      .expect(201);
    const cookie = String(login.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
    await request(server()).post(`${PREFIX}/auth/logout`).set("cookie", cookie).expect(201);
    const rows = (await audits(since)).filter((row) => row.category === "AUTH");
    expect(rows.map((row) => [row.action, row.outcome, row.statusCode])).toEqual([
      ["POST /auth/register", "SUCCESS", 201],
      ["POST /auth/login", "DENIED", 401],
      ["POST /auth/login", "SUCCESS", 201],
      ["POST /auth/logout", "SUCCESS", 201],
    ]);
    expect(rows[0]).toMatchObject({ actorUserId: registeredUserId, correlationId });
    expect(rows[1]?.actorUserId).toBeNull();
    expect(rows[3]?.actorUserId).toBe(registeredUserId);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(SECRET_PASSWORD);
    expect(serialized).not.toContain(registerEmail);
    expect(serialized).not.toContain(cookie.split("=")[1] ?? "never");
  });

  it("audits config, approval, connection and publishing attempts, including denials", async () => {
    if (!db) return;
    const since = new Date();
    const missing = randomUUID();
    const base = `${PREFIX}/workspaces/${workspaceId}`;
    await request(server())
      .post(`${base}/channels/${channelId}/status`)
      .set(auth(tokens.owner))
      .send({ status: "PAUSED" })
      .expect(201);
    await request(server())
      .post(`${base}/channels/${channelId}/status`)
      .set(auth(tokens.viewer))
      .send({ status: "ACTIVE" })
      .expect(403);
    await request(server())
      .post(`${base}/quality/runs/${missing}/decision`)
      .set(auth(tokens.owner))
      .send({ decision: "APPROVE" })
      .expect((response) => expect(response.status).toBeGreaterThanOrEqual(400));
    await request(server())
      .post(`${base}/social-accounts/${missing}/revoke`)
      .set(auth(tokens.owner))
      .expect((response) => expect(response.status).toBeGreaterThanOrEqual(400));
    await request(server())
      .get(`${PREFIX}/social-accounts/oauth/youtube/callback?state=forged&code=4%2F0secret-code`)
      .expect((response) => expect(response.status).toBeGreaterThanOrEqual(300));
    await request(server())
      .post(`${base}/publishing/destinations/${missing}/publish`)
      .set(auth(tokens.owner))
      .expect((response) => expect(response.status).toBeGreaterThanOrEqual(400));
    const rows = await audits(since);
    const summary = rows.map((row) => [row.category, row.outcome, row.actorUserId]);
    expect(summary).toContainEqual(["CONFIG", "SUCCESS", ownerId]);
    expect(summary).toContainEqual(["CONFIG", "DENIED", viewerId]);
    expect(rows.find((row) => row.category === "CONFIG")?.targetIds).toMatchObject({ channelId });
    expect(rows.some((row) => row.category === "APPROVAL" && row.actorUserId === ownerId)).toBe(
      true,
    );
    expect(rows.filter((row) => row.category === "CONNECTION")).toHaveLength(2);
    expect(
      rows.some((row) => row.category === "PUBLISHING" && row.workspaceId === workspaceId),
    ).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("secret-code");
    expect(rows.every((row) => /^[0-9a-f-]{36}$/.test(row.correlationId))).toBe(true);
  });

  it("keeps audit_events append-only even for the database owner", async () => {
    if (!db) return;
    const row = await db.auditEvent.findFirstOrThrow({ where: { workspaceId } });
    await expect(
      db.$executeRawUnsafe(`UPDATE audit_events SET action = 'x' WHERE id = '${row.id}'`),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.$executeRawUnsafe(`DELETE FROM audit_events WHERE id = '${row.id}'`),
    ).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe("TRUNCATE audit_events")).rejects.toThrow(/append-only/);
    expect(await db.auditEvent.count({ where: { id: row.id } })).toBe(1);
  });

  it("restricts admin views and the audit log to the workspace OWNER and its own tenant", async () => {
    if (!db) return;
    const base = `${PREFIX}/workspaces/${workspaceId}/admin`;
    for (const path of ["audit-events", "failed-jobs", "queue", "providers", "events"]) {
      await request(server()).get(`${base}/${path}`).expect(401);
      await request(server()).get(`${base}/${path}`).set(auth(tokens.editor)).expect(403);
      await request(server()).get(`${base}/${path}`).set(auth(tokens.viewer)).expect(403);
      await request(server()).get(`${base}/${path}`).set(auth(tokens.outsider)).expect(403);
      await request(server()).get(`${base}/${path}`).set(auth(tokens.owner)).expect(200);
    }
    const failed = await request(server())
      .get(`${base}/failed-jobs`)
      .set(auth(tokens.owner))
      .expect(200);
    const runs = (
      failed.body as { items: { workflowRuns: Array<{ id: string; errorMessage: string }> } }
    ).items.workflowRuns;
    expect(runs.map((run) => run.id)).toEqual([failedRunId]);
    expect(runs[0]?.errorMessage).not.toContain("X-Goog-Signature");
    expect(runs[0]?.errorMessage).not.toContain("ya29.");
    const auditList = await request(server())
      .get(`${base}/audit-events?limit=200`)
      .set(auth(tokens.owner))
      .expect(200);
    const items = auditList.body as Array<{ workspaceId: string | null }>;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.workspaceId === workspaceId)).toBe(true);
    const foreign = await request(server())
      .get(`${PREFIX}/workspaces/${foreignWorkspaceId}/admin/failed-jobs`)
      .set(auth(tokens.outsider))
      .expect(200);
    expect(JSON.stringify(foreign.body)).not.toContain(failedRunId);
    const providers = await request(server())
      .get(`${base}/providers`)
      .set(auth(tokens.owner))
      .expect(200);
    expect(JSON.stringify(providers.body)).not.toMatch(/token|secret/i);
  });

  it("sets and clears the emergency stop over HTTP and blocks manual runs while active", async () => {
    if (!db) return;
    const base = `${PREFIX}/workspaces/${workspaceId}`;
    await db.channel.update({ where: { id: channelId }, data: { status: "ACTIVE" } });
    await request(server())
      .put(`${base}/admin/emergency-stop`)
      .set(auth(tokens.editor))
      .send({ scope: "WORKSPACE", active: true, reason: "nope" })
      .expect(403);
    await request(server())
      .put(`${base}/admin/emergency-stop`)
      .set(auth(tokens.owner))
      .send({ scope: "CHANNEL", channelId: foreignChannelId, active: true, reason: "cross tenant" })
      .expect(404);
    await request(server())
      .put(`${base}/admin/emergency-stop`)
      .set(auth(tokens.owner))
      .send({ scope: "WORKSPACE", active: true })
      .expect(400);
    const since = new Date();
    await request(server())
      .put(`${base}/admin/emergency-stop`)
      .set(auth(tokens.owner))
      .send({ scope: "WORKSPACE", active: true, reason: "Incident 7" })
      .expect(200);
    const status = await request(server())
      .get(`${base}/admin/emergency-stop`)
      .set(auth(tokens.viewer))
      .expect(200);
    expect(status.body).toMatchObject({
      stops: [{ scope: "WORKSPACE", active: true, reason: "Incident 7" }],
    });
    const blocked = await request(server())
      .post(`${base}/orchestration/runs`)
      .set(auth(tokens.editor))
      .send({ definitionKey: "GENERATION", channelId, ideaId: randomUUID() })
      .expect(409);
    expect(JSON.stringify(blocked.body)).toMatch(/EMERGENCY_STOP/);
    await request(server())
      .put(`${base}/admin/emergency-stop`)
      .set(auth(tokens.owner))
      .send({ scope: "WORKSPACE", active: false, reason: "Resolved" })
      .expect(200);
    const rows = (await audits(since)).filter((row) => row.category === "ADMIN");
    expect(rows.map((row) => row.action)).toEqual(["EMERGENCY_STOP_SET", "EMERGENCY_STOP_CLEARED"]);
  });

  it("hides /ops/metrics unless an operator token is configured", async () => {
    await request(server()).get(`${PREFIX}/ops/metrics`).expect(404);
    process.env["OPS_METRICS_TOKEN"] = "m19-ops-token-0123456789";
    try {
      await request(server())
        .get(`${PREFIX}/ops/metrics`)
        .set(auth("wrong-token-0123456789"))
        .expect(404);
      const metrics = await request(server())
        .get(`${PREFIX}/ops/metrics`)
        .set(auth("m19-ops-token-0123456789"))
        .expect(200);
      expect(metrics.text).toContain("reelforge_http_requests_total");
      expect(metrics.text).toContain("reelforge_audit_events_total");
      expect(metrics.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    } finally {
      delete process.env["OPS_METRICS_TOKEN"];
    }
  });
});

/**
 * Routes that intentionally have no AuthGuard: health probes, credential exchange, the OAuth
 * redirect (state-bound), and the operator metrics scrape (404 unless OPS_METRICS_TOKEN matches).
 * Adding a route here is a security-review item (M19-T08 checklist).
 */
const PUBLIC_ROUTES: string[] = [
  "HealthController.getHealth",
  "IdentityController.login",
  "IdentityController.register",
  "OpsMetricsController.metrics",
  "SocialOAuthCallbackController.callback",
];
