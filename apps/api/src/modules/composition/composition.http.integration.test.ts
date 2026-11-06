import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createDatabaseClient } from "@reelforge/database";
import { hashSessionToken } from "../identity/auth.crypto.js";
import { COMPOSITION_ENGINE } from "./composition.types.js";
import { CompositionModule } from "./composition.module.js";
const databaseUrl = process.env.DATABASE_URL;
const suite = describe.skipIf(databaseUrl === undefined);
const ownerId=randomUUID(),viewerId=randomUUID(),outsiderId=randomUUID(),workspaceId=randomUUID();
suite("composition authentication and workspace membership",()=>{
  const db=databaseUrl?createDatabaseClient(databaseUrl):undefined;
  let app:INestApplication|undefined;let ownerToken="",viewerToken="",outsiderToken="";
  beforeAll(async()=>{
    if(!db)return;
    await db.user.createMany({data:[ownerId,viewerId,outsiderId].map((id)=>({id,email:`${id}@m10-http.invalid`}))});
    await db.workspace.create({data:{id:workspaceId,name:"m10-http"}});
    await db.workspaceMembership.createMany({data:[{workspaceId,userId:ownerId,role:"OWNER"},{workspaceId,userId:viewerId,role:"VIEWER"}]});
    const sessions=[];
    for(const id of [ownerId,viewerId,outsiderId]){const token=randomUUID();sessions.push(token);await db.session.create({data:{userId:id,tokenHash:hashSessionToken(token),expiresAt:new Date(Date.now()+60000)}});}
    [ownerToken,viewerToken,outsiderToken]=sessions;
    const module=await Test.createTestingModule({imports:[CompositionModule]}).overrideProvider("DATABASE").useValue(db).overrideProvider(COMPOSITION_ENGINE).useValue({execute:async()=>{throw new Error("engine must not run for invalid jobs")}}).compile();
    app=module.createNestApplication();await app.init();
  });
  afterAll(async()=>{await app?.close();if(db){await db.workspace.delete({where:{id:workspaceId}});await db.user.deleteMany({where:{id:{in:[ownerId,viewerId,outsiderId]}}});await db.$disconnect();}});
  it("requires a session, workspace membership, and editor permission",async()=>{
    const base=`/workspaces/${workspaceId}/composition`;
    await request(app!.getHttpServer() as never).get(`${base}/jobs/${randomUUID()}`).expect(401);
    await request(app!.getHttpServer() as never).get(`${base}/jobs/${randomUUID()}`).set("Authorization",`Bearer ${outsiderToken}`).expect(403);
    await request(app!.getHttpServer() as never).post(`${base}/jobs`).set("Authorization",`Bearer ${viewerToken}`).send({}).expect(403);
    await request(app!.getHttpServer() as never).get(`${base}/jobs/${randomUUID()}`).set("Authorization",`Bearer ${ownerToken}`).expect(404);
  });
});
