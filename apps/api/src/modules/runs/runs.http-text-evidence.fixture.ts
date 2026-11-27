import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, vi } from "vitest";
import { bindMedia } from "../composition/media-bindings.fixture.js";
import { fakeMediaPorts } from "../composition/media-recovery.fixture.js";
import { hashSessionToken } from "../identity/auth.crypto.js";
import type { Tenant } from "./runs.fixture.js";

export async function assertOwnerReportedTextEvidence(
  app: INestApplication,
  receiptTenant: Tenant,
  editorUserId: string,
  foreignOwnerToken: string,
): Promise<void> {
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
  vi.stubEnv("PAID_TEXT_V3_ENABLED", "1");
  const step = await accounts.begin(
    receiptTenant.context,
    current,
    "media:text:scriptwriter",
    {},
    7,
    "fixture-text",
    true,
  );
  const sent = vi.fn(async (bodySent: () => Promise<void>): Promise<never> => {
    await bodySent();
    throw new Error("lost reply");
  });
  await expect(accounts.dispatchTextAttempt(receiptTenant.context, step, sent)).rejects.toThrow(
    "lost reply",
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
      userId: editorUserId,
      role: "EDITOR",
    },
  });
  await receiptTenant.db.session.create({
    data: {
      userId: editorUserId,
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
  await post(foreignOwnerToken).send(data).expect(403);
  await post(editor).send(data).expect(403);
  await post(owner)
    .send({ ...data, dispatchKey: "wrong-attempt" })
    .expect(409);
  await post(owner).send(data).expect(204);
  const reservation = { workspaceId: receiptTenant.context.workspaceId, correlationId: step.id };
  expect(await receiptTenant.db.usageReservation.findMany({ where: reservation })).toMatchObject([
    { status: "RESERVED", committedMinor: null, amountMinor: 7n },
  ]);
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
      providerJobId: null,
      costKnown: false,
      netMinor: 7,
    },
  });
  expect(await receiptTenant.db.usageReservation.findMany({ where: reservation })).toMatchObject([
    { status: "COMMITTED", committedMinor: 7n },
  ]);
  const fill = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`counter_${index}`, 1]),
  );
  await post(owner)
    .send({ ...data, usage: fill })
    .expect(204);
  const readReceipt = (): ReturnType<Tenant["db"]["providerRequest"]["findFirstOrThrow"]> =>
    receiptTenant.db.providerRequest.findFirstOrThrow({ where: { correlationId: step.id } });
  const bounded = await readReceipt();
  const journalWhere = {
    workspaceId: receiptTenant.context.workspaceId,
    attemptId: step.id,
    kind: "RECOVERED_RECEIPT" as const,
  };
  const readEvidence = (): ReturnType<Tenant["db"]["textAttemptEvidence"]["findMany"]> =>
    receiptTenant.db.textAttemptEvidence.findMany({
      where: journalWhere,
      orderBy: { sequence: "asc" },
    });
  const evidence = await readEvidence();
  expect(evidence).toHaveLength(3);
  expect(evidence.at(-1)?.data).toMatchObject({
    dispatchKey: step.idempotencyKey,
    source: "owner_reported",
    googleId: data.providerJobId,
    usage: { input_tokens: 12, output_tokens: 3, ...fill },
  });
  expect(
    await receiptTenant.db.runEvent.findFirst({
      where: { stepId: step.id, type: "text_evidence_recorded" },
      orderBy: { sequence: "desc" },
    }),
  ).toMatchObject({ payload: { usage: fill } });
  expect(bounded).toMatchObject({
    actualCost: null,
    usage: null,
    responseMetadata: { dispatchKey: step.idempotencyKey, providerJobId: null, costKnown: false },
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
  expect(await readEvidence()).toEqual(evidence);
  await post(owner)
    .send({ ...data, usage: { input_tokens: 12, output_tokens: 3, ...fill } })
    .expect(204);
  expect(await readEvidence()).toEqual(evidence);
  expect(await readReceipt()).toEqual(bounded);
  expect(sent).toHaveBeenCalledOnce();
}
