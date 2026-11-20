import { createHash, randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createDatabaseClient } from "@reelforge/database";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountFixture } from "./account-email.fixture.js";
import { AccountEmailService } from "./account-email.service.js";
import {
  ACCOUNT_EMAIL,
  createAccountEmailPort,
  type AccountEmailPort,
} from "./account-email.port.js";
import { createSessionToken, hashSessionToken, verifyPassword } from "./auth.crypto.js";
import { createCsrfToken, csrfMiddleware } from "./csrf.middleware.js";
import { IdentityModule } from "./identity.module.js";

const databaseUrl = process.env.DATABASE_URL;
const origin = "https://studio.example";
const currentPassword = "current-password-123";
const newPassword = "replacement-password-456";
describe.skipIf(!databaseUrl)("mounted account email with offline relay", () => {
  const db = createDatabaseClient(databaseUrl ?? "postgresql://unused");
  const users: string[] = [];
  const send = vi.fn<AccountEmailPort["send"]>().mockResolvedValue(undefined);
  const relay = { available: true, send };
  const account = new AccountEmailService(db, relay);
  let app: NestExpressApplication;
  const sourceIp = `fd00::${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}`;

  beforeAll(async () => {
    vi.stubEnv("WEB_APP_ORIGIN", origin);
    const module = await Test.createTestingModule({ imports: [IdentityModule] })
      .overrideProvider("DATABASE")
      .useValue(db)
      .overrideProvider(ACCOUNT_EMAIL)
      .useValue({ send })
      .overrideProvider(AccountEmailService)
      .useValue({
        requestReset: account.requestReset.bind(account),
        requestEmailChange: account.requestEmailChange.bind(account),
        resetPassword: account.resetPassword.bind(account),
        confirmEmail: account.confirmEmail.bind(account),
      })
      .compile();
    app = module.createNestApplication<NestExpressApplication>();
    app.set("trust proxy", "loopback");
    app.setGlobalPrefix("api/v1");
    app.use(csrfMiddleware);
    await app.init();
  });
  beforeEach(() => {
    send.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await app?.close();
    await db.authEvent.deleteMany({ where: { userId: { in: users } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
    vi.unstubAllEnvs();
  });

  const api = (): ReturnType<typeof request> => request(app.getHttpServer());
  function post(path: string, auth?: string, from = origin): request.Test {
    const csrf = createCsrfToken();
    const call = api()
      .post(`/api/v1/auth/${path}`)
      .set("Cookie", `reelforge_csrf=${csrf}`)
      .set("X-CSRF-Token", csrf)
      .set("X-Forwarded-For", sourceIp)
      .set("Origin", from);
    return auth ? call.set("Authorization", `Bearer ${auth}`) : call;
  }
  async function fixture(email?: string): ReturnType<typeof createAccountFixture> {
    const user = await createAccountFixture(db, currentPassword, email);
    users.push(user.id);
    return user;
  }
  async function codeFor(email: string): Promise<string> {
    for (
      let attempt = 0;
      attempt < 20 && !send.mock.calls.some(([mail]) => mail.to === email);
      attempt++
    )
      await account.processResetDelivery();
    const call = send.mock.calls.findLast(([mail]) => mail.to === email);
    if (!call) throw new Error("Expected delivery");
    return call[0].code;
  }
  const me = (token: string): request.Test =>
    api().get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);

  it.each(["password-reset", "password-reset/confirm", "email-change/confirm"] as const)(
    "checks CSRF for each mounted spelling of %s",
    async (path) => {
      const missing = `${randomUUID()}@example.test`;
      for (const spelling of [path, `${path}/`, path.toUpperCase(), `${path.toUpperCase()}/`]) {
        let body: { email: string } | { code: string; password?: string } = { email: missing };
        if (path !== "password-reset") {
          const user = await fixture();
          if (path === "password-reset/confirm") {
            await account.requestReset(user.email, randomUUID());
            body = { code: await codeFor(user.email), password: newPassword };
          } else {
            const target = `verified-${user.email}`;
            await account.requestEmailChange(user.id, target, currentPassword);
            body = { code: await codeFor(target) };
          }
        }
        await api().post(`/api/v1/auth/${spelling}`).send(body).expect(403);
        await post(spelling, undefined, "https://other.example").send(body).expect(403);
        await post(spelling)
          .send(body)
          .expect(path === "password-reset" ? 202 : 204);
      }
    },
  );

  it("returns equal public responses while existence and relay work wait for the worker", async () => {
    const user = await fixture();
    const missing = `${randomUUID()}@example.test`;
    send.mockRejectedValue(new Error("offline outage"));
    const lookup = vi.spyOn(db.user, "findUnique");
    for (const email of [user.email, missing, user.email]) {
      const result = await post("password-reset").send({ email }).expect(202);
      expect(result.text).toBe("");
      expect(result.headers["cache-control"]).toBe("no-store");
    }
    expect(send).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(await db.emailChallenge.count({ where: { userId: user.id } })).toBe(0);
    const original = await codeFor(user.email);
    const lookupsAfterDelivery = lookup.mock.calls.length;
    expect(lookupsAfterDelivery).toBeGreaterThan(0);
    const result = await post("password-reset").send({ email: user.email }).expect(202);
    expect(result.text).toBe("");
    expect(lookup).toHaveBeenCalledTimes(lookupsAfterDelivery);
    lookup.mockRestore();
    expect(send.mock.calls.filter(([mail]) => mail.to === user.email)).toHaveLength(1);
    await db.accountResetDelivery.updateMany({
      where: { email: user.email },
      data: { availableAt: new Date(0) },
    });
    const restartSend = vi.fn<AccountEmailPort["send"]>().mockResolvedValue(undefined);
    const restart = new AccountEmailService(db, { send: restartSend });
    await restart.processResetDelivery();
    expect(restartSend).toHaveBeenCalledWith({
      to: user.email,
      purpose: "RESET_PASSWORD",
      code: original,
    });
    expect(await db.accountResetDelivery.count({ where: { email: user.email } })).toBe(0);

    expect(createAccountEmailPort({}).available).toBe(false);
    relay.available = false;
    try {
      for (const email of [user.email, missing])
        await post("password-reset").send({ email }).expect(503);
    } finally {
      relay.available = true;
    }
  });

  it("limits source and aggregate admission and scrubs token material after bounded retries", async () => {
    const source = randomUUID();
    const emails = Array.from({ length: 13 }, () => `${randomUUID()}@example.test`);
    await Promise.all(emails.slice(0, 12).map((email) => account.requestReset(email, source)));
    expect(await db.accountResetDelivery.count({ where: { email: { in: emails } } })).toBe(10);
    await account.requestReset(emails[12]!, randomUUID());
    expect(await db.accountResetDelivery.count({ where: { email: { in: emails } } })).toBe(11);
    await db.accountResetDelivery.deleteMany({ where: { email: { in: emails } } });

    const aggregateEmails = Array.from({ length: 3 }, () => `${randomUUID()}@example.test`);
    const key = `reset:aggregate:${createHash("sha256").update("").digest("hex")}`;
    const previous = await db.accountEmailLimit.findUniqueOrThrow({ where: { key } });
    await db.accountEmailLimit.update({
      where: { key },
      data: { count: 119, expiresAt: new Date(Date.now() + 60_000) },
    });
    try {
      await Promise.all(aggregateEmails.map((email) => account.requestReset(email, randomUUID())));
      expect(
        await db.accountResetDelivery.count({ where: { email: { in: aggregateEmails } } }),
      ).toBe(1);
    } finally {
      await db.accountResetDelivery.deleteMany({ where: { email: { in: aggregateEmails } } });
      await db.accountEmailLimit.update({ where: { key }, data: previous });
    }

    const user = await fixture();
    send.mockRejectedValue(new Error("relay down"));
    await account.requestReset(user.email, randomUUID());
    const original = await codeFor(user.email);
    for (let attempt = 1; attempt < 4; attempt++) {
      await db.accountResetDelivery.updateMany({
        where: { email: user.email },
        data: { availableAt: new Date(0) },
      });
      await account.processResetDelivery();
    }
    expect(
      send.mock.calls.filter(([mail]) => mail.to === user.email).map(([mail]) => mail.code),
    ).toEqual(Array(4).fill(original));
    expect(await db.accountResetDelivery.count({ where: { email: user.email } })).toBe(0);

    const expired = await db.accountResetDelivery.create({
      data: {
        id: randomUUID(),
        email: user.email,
        code: original,
        expiresAt: new Date(0),
      },
    });
    await new AccountEmailService(db, createAccountEmailPort({})).processResetDelivery();
    expect(await db.accountResetDelivery.findUnique({ where: { id: expired.id } })).toBeNull();
  });

  it("completes reset while an old-password login races it", async () => {
    const user = await fixture();
    await me(user.token).expect(200);
    await post("password-reset").send({ email: user.email }).expect(202);
    const code = await codeFor(user.email);
    const [reset, login] = await Promise.all([
      post("password-reset/confirm").send({ code, password: newPassword }),
      post("login").send({ email: user.email, password: currentPassword }),
    ]);
    expect(reset.status).toBe(204);
    expect([201, 401]).toContain(login.status);
    await me(user.token).expect(401);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    const credential = await db.passwordCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(await verifyPassword(newPassword, credential.passwordHash)).toBe(true);
    await post("login").send({ email: user.email, password: newPassword }).expect(201);
  });

  it("retries after relay failure, rejects a newly occupied target, and verifies a different mailbox", async () => {
    const user = await fixture();
    const target = `new-${user.email}`;
    const change = (email: string): request.Test =>
      post("me/email-change", user.token).send({ email, password: currentPassword });
    const occupied = await fixture();
    await change(occupied.email).expect(409);
    expect(send).not.toHaveBeenCalled();
    expect(await db.emailChallenge.count({ where: { userId: user.id } })).toBe(0);
    send.mockRejectedValueOnce(new Error("relay unavailable"));
    await change(target).expect(503);
    expect(await db.emailChallenge.count({ where: { userId: user.id } })).toBe(0);
    await me(user.token).expect(200);
    await change(target).expect(202);
    const code = send.mock.calls[1]![0].code;
    await fixture(target);
    await post("email-change/confirm").send({ code }).expect(409);
    expect(await db.user.findUnique({ where: { id: user.id } })).toMatchObject({
      email: user.email,
    });
    await me(user.token).expect(200);

    await db.emailChallenge.updateMany({
      where: { userId: user.id },
      data: { issuedAt: new Date(0) },
    });
    const fresh = `other-${user.email}`;
    await change(fresh).expect(202);
    await post("email-change/confirm").send({ code: send.mock.calls[2]![0].code }).expect(204);
    expect(await db.user.findUnique({ where: { id: user.id } })).toMatchObject({
      email: fresh,
      emailVerifiedAt: expect.any(Date),
    });
    await me(user.token).expect(401);
  });

  it("serializes reset against authenticated password change", async () => {
    const user = await fixture();
    const siblingToken = createSessionToken();
    await db.session.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(siblingToken),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await post("password-reset").send({ email: user.email }).expect(202);
    const code = await codeFor(user.email);
    const alternate = "alternate-password-789";
    const [reset, change] = await Promise.all([
      post("password-reset/confirm").send({ code, password: newPassword }),
      post("me/password", user.token).send({ currentPassword, newPassword: alternate }),
    ]);
    expect(Number(reset.status === 204) + Number(change.status === 201)).toBe(1);
    await me(user.token).expect(reset.status === 204 ? 401 : 200);
    await me(siblingToken).expect(401);
    expect(await db.emailChallenge.count({ where: { userId: user.id } })).toBe(0);
    const credential = await db.passwordCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(
      await verifyPassword(reset.status === 204 ? newPassword : alternate, credential.passwordHash),
    ).toBe(true);
  });

  it("atomically caps concurrent reauthentication and independently caps a destination during outage", async () => {
    const user = await fixture();
    const burst = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        post("me/email-change", user.token).send({
          email: `${i}-${user.email}`,
          password: "wrong",
        }),
      ),
    );
    expect(burst.map((result) => result.status).sort()).toEqual([
      ...Array(5).fill(401),
      ...Array(7).fill(429),
    ]);
    expect(send).not.toHaveBeenCalled();
    send.mockRejectedValue(new Error("relay unavailable"));
    const target = `outage-${user.email}`;
    for (let i = 0; i < 6; i++) {
      const caller = await fixture();
      await post("me/email-change", caller.token)
        .send({ email: target, password: currentPassword })
        .expect(i === 5 ? 429 : 503);
    }
    expect(send).toHaveBeenCalledTimes(5);
  });
});

describe.skipIf(!databaseUrl)("account email challenges with offline delivery", () => {
  const db = createDatabaseClient(databaseUrl ?? "postgresql://unused");
  const userIds: string[] = [];
  const password = "current-password-123";
  const replacement = "replacement-password-456";
  const send = vi.fn<AccountEmailPort["send"]>().mockResolvedValue(undefined);
  const account = new AccountEmailService(db, { send });
  beforeEach(() => {
    send.mockClear();
  });
  afterAll(async () => {
    await db.authEvent.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  });

  async function fixture(): ReturnType<typeof createAccountFixture> {
    const user = await createAccountFixture(db, password);
    userIds.push(user.id);
    return user;
  }

  it("issues only one code during cooldown and consumes it atomically once", async () => {
    const user = await fixture();
    await account.requestReset(`${randomUUID()}@example.test`, randomUUID());
    expect(send).not.toHaveBeenCalled();
    await Promise.all([
      account.requestReset(user.email, randomUUID()),
      account.requestReset(user.email, randomUUID()),
    ]);
    expect(send).not.toHaveBeenCalled();
    await account.processResetDelivery();
    await account.processResetDelivery();
    expect(send).toHaveBeenCalledTimes(1);
    const { code } = send.mock.calls[0]![0];
    const saved = await db.emailChallenge.findFirstOrThrow({ where: { userId: user.id } });
    expect(saved.tokenHash).toBe(hashSessionToken(code));
    await expect(account.confirmEmail(code)).rejects.toThrow("Invalid or expired");
    const results = await Promise.allSettled([
      account.resetPassword(code, replacement),
      account.resetPassword(code, replacement),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const credential = await db.passwordCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(await verifyPassword(replacement, credential.passwordHash)).toBe(true);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });

  it("expires old codes and changes a mailbox only after verification", async () => {
    const user = await fixture();
    const target = `new-${user.email}`;
    await expect(account.requestEmailChange(user.id, target, "incorrect")).rejects.toThrow(
      "Invalid credentials",
    );
    await account.requestEmailChange(user.id, target, password);
    const first = send.mock.calls[0]![0];
    expect(first).toMatchObject({ to: target, purpose: "CHANGE_EMAIL" });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(user.email);
    await db.emailChallenge.updateMany({
      where: { userId: user.id },
      data: { issuedAt: new Date(0), expiresAt: new Date(1) },
    });
    await expect(account.confirmEmail(first.code)).rejects.toThrow("Invalid or expired");
    await account.requestEmailChange(user.id, target, password);
    const second = send.mock.calls[1]![0];
    await account.confirmEmail(second.code);
    const saved = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(saved.email).toBe(target);
    expect(saved.emailVerifiedAt).not.toBeNull();
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    await expect(account.confirmEmail(second.code)).rejects.toThrow("Invalid or expired");
  });
});
