import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { RunsModule } from "./runs.module.js";
import type { Tenant } from "./runs.fixture.js";

export async function postEditorApproval(t: Tenant): Promise<request.Response> {
  const { userId, workspaceId } = t.context;
  await t.db.workspaceMembership.update({
    where: { workspaceId_userId: { workspaceId, userId } },
    data: { role: "EDITOR" },
  });
  const token = randomUUID();
  await t.db.session.create({
    data: { userId, tokenHash: hashSessionToken(token), expiresAt: new Date(Date.now() + 60_000) },
  });
  const module = await Test.createTestingModule({ imports: [RunsModule] })
    .overrideProvider("DATABASE")
    .useValue(t.db)
    .compile();
  const app = module.createNestApplication();
  try {
    app.setGlobalPrefix("api/v1");
    await app.init();
    return await request(app.getHttpServer())
      .post(`/api/v1/runs/${t.run.id}/approve`)
      .query({ workspaceId })
      .set("Authorization", `Bearer ${token}`);
  } finally {
    await app.close();
  }
}
