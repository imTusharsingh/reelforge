import { Controller, Get, Module, Post, RequestMethod } from "@nestjs/common";
import type { MiddlewareConsumer, NestModule } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csrfMiddleware } from "./csrf.middleware.js";

@Controller()
class FixtureController {
  @Post("auth/login")
  login(): { ok: true } {
    return { ok: true };
  }
  @Post("items")
  item(): { ok: true } {
    return { ok: true };
  }
  @Get("health")
  health(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [FixtureController] })
class FixtureModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(csrfMiddleware).forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}

describe("CSRF HTTP boundary", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.WEB_APP_ORIGIN = "https://studio.example";
    const module = await Test.createTestingModule({ imports: [FixtureModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });
  afterAll(async () => {
    delete process.env.WEB_APP_ORIGIN;
    await app.close();
  });

  it("accepts matching token and origin, rejects missing token/origin, and protects pre-auth login", async () => {
    const token = "a".repeat(43);
    const server = app.getHttpServer() as never;
    await request(server)
      .post("/api/v1/auth/login")
      .set("Origin", "https://studio.example")
      .expect(403);
    await request(server)
      .post("/api/v1/auth/login")
      .set("Origin", "https://studio.example")
      .set("Cookie", `reelforge_csrf=${token}`)
      .set("X-CSRF-Token", token)
      .expect(201);
    await request(server)
      .post("/api/v1/items")
      .set("Cookie", [`reelforge_session=session`, `reelforge_csrf=${token}`])
      .set("Origin", "https://evil.example")
      .set("X-CSRF-Token", token)
      .expect(({ body }) => expect(body.code).toBe("CSRF_ORIGIN_INVALID"))
      .expect(403);
  });

  it("exempts safe routes and Bearer-only requests, but not Bearer plus session", async () => {
    const server = app.getHttpServer() as never;
    await request(server).get("/api/v1/health").expect(200);
    await request(server).post("/api/v1/items").set("Authorization", "Bearer token").expect(201);
    await request(server)
      .post("/api/v1/items")
      .set("Authorization", "Bearer token")
      .set("Cookie", "reelforge_session=session")
      .expect(({ body }) => expect(body.code).toBe("CSRF_TOKEN_INVALID"))
      .expect(403);
  });
});
