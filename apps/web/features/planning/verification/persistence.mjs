/** Test-only actual M06/M07 + Prisma verification. Requires built workspace packages. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "../../../../../packages/database/dist/index.js";
import { ProviderRegistry } from "../../../../../packages/ai-providers/dist/index.js";
import { IdeaService } from "../../../../api/dist/modules/idea/idea.service.js";
import { ScriptService } from "../../../../api/dist/modules/script/script.service.js";
const url = process.env.M24_TEST_DATABASE_URL;
if (
  !url ||
  !/^postgresql:\/\/[^/]*@(127\.0\.0\.1|localhost):/.test(url) ||
  !url.includes("reelforge_dev")
)
  throw new Error("Requires local disposable reelforge_dev M24_TEST_DATABASE_URL");
const db = createDatabaseClient(url);
const userId = randomUUID(),
  workspaceId = randomUUID(),
  foreignWorkspaceId = randomUUID(),
  channelId = randomUUID();
const owner = { userId, workspaceId, role: "OWNER" },
  editor = { ...owner, role: "EDITOR" },
  viewer = { ...owner, role: "VIEWER" };
const forbiddenProvider = async () => {
  throw new Error("No provider calls in tests");
};
const ideas = new IdeaService(db, { proposeIdea: forbiddenProvider });
const scripts = new ScriptService(db, { complete: forbiddenProvider }, new ProviderRegistry());
const input = () => ({
  title: `M24 brief ${randomUUID()}`,
  topic: randomUUID(),
  hook: "Opening",
  angle: "Perspective",
  audience: "Creators",
  expectedFormat: "short-form-video",
  channelId,
  references: ["https://example.com/source"],
  sourceNotes: "Detailed brief",
});
const document = {
  schemaVersion: "1.0",
  title: "M24 persisted storyboard",
  hook: "Opening",
  dialogue: "",
  cta: "Try it",
  metadata: { genre: "M24 Education", targetDurationSeconds: 20, factual: false },
  scenes: [
    {
      id: "one",
      startSeconds: 0,
      durationSeconds: 10,
      characterRefs: [],
      dialogue: "First",
      visualDescription: "Desk",
      camera: "Close",
      audioCues: [],
    },
    {
      id: "two",
      startSeconds: 10,
      durationSeconds: 10,
      characterRefs: [],
      dialogue: "Second",
      visualDescription: "Notebook",
      camera: "Wide",
      audioCues: [],
    },
  ],
};
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log("PASS " + name);
}
try {
  await db.user.create({ data: { id: userId, email: `${userId}@m24-test.invalid` } });
  await db.workspace.createMany({
    data: [
      { id: workspaceId, name: "M24 disposable test" },
      { id: foreignWorkspaceId, name: "M24 foreign test" },
    ],
  });
  await db.workspaceMembership.create({ data: { userId, workspaceId, role: "OWNER" } });
  await db.channel.create({ data: { id: channelId, workspaceId, name: "M24 test channel" } });
  await db.genre.create({
    data: {
      workspaceId,
      name: document.metadata.genre,
      audience: "creators",
      tone: "clear",
      topicsAllowed: [],
      topicsBlocked: [],
      language: "en",
      structure: {},
      durationPreference: {},
      safetyProfile: { requiresSourceBackedClaims: false },
    },
  });
  await test("persisted idea brief, stale timestamp conflict, archive, filtered list and restore", async () => {
    const original = await ideas.create(owner, input(), "USER");
    const edited = await ideas.edit(
      editor,
      original.id,
      { ...input(), title: "Saved detailed brief" },
      original.updatedAt,
    );
    assert.equal(edited.title, "Saved detailed brief");
    await assert.rejects(
      () => ideas.edit(editor, original.id, input(), original.updatedAt),
      /changed/,
    );
    const archived = await ideas.archive(editor, edited.id, edited.updatedAt);
    assert(archived.archivedAt);
    assert.equal(archived.status, "DRAFT");
    assert.deepEqual(await ideas.list(viewer), []);
    const restored = await ideas.restore(editor, edited.id, archived.updatedAt);
    assert.equal(restored.archivedAt, null);
    assert.equal(
      (await db.idea.findUniqueOrThrow({ where: { id: edited.id } })).title,
      "Saved detailed brief",
    );
  });
  await test("viewer mutations and cross-tenant channel references are denied", async () => {
    await assert.rejects(() => ideas.create(viewer, input(), "USER"), /permission/);
    await assert.rejects(
      () => ideas.create({ ...owner, workspaceId: foreignWorkspaceId }, input(), "USER"),
      /Channel/,
    );
  });
  await test("approved snapshots remain immutable after rejection", async () => {
    const idea = await ideas.create(owner, input(), "USER");
    await ideas.transition(owner, idea.id, "APPROVED", idea.updatedAt, idea.status);
    const snapshot = await ideas.getApproved(viewer, idea.id);
    assert.equal(snapshot.checksumSha256.length, 64);
    const approvedRow = await db.idea.findUniqueOrThrow({ where: { id: idea.id } });
    await assert.rejects(
      () => ideas.transition(owner, idea.id, "REJECTED", approvedRow.updatedAt, "DRAFT"),
      /changed/,
    );
    await assert.rejects(
      () => ideas.transition(owner, idea.id, "REJECTED", idea.updatedAt, "APPROVED"),
      /changed/,
    );
    await ideas.transition(owner, idea.id, "REJECTED", approvedRow.updatedAt, approvedRow.status);
    await assert.rejects(
      () => ideas.edit(editor, idea.id, input(), idea.updatedAt),
      /cannot be edited/,
    );
    await assert.rejects(() => ideas.archive(editor, idea.id, idea.updatedAt));
  });
  await test("targeted scenes and ordering persist, genuine history remains unchanged, approved scripts lock", async () => {
    const idea = await ideas.create(owner, input(), "USER");
    await ideas.transition(owner, idea.id, "APPROVED", idea.updatedAt, idea.status);
    const snapshot = await ideas.getApproved(owner, idea.id);
    // Explicit test-only existing-script fixture; the application never fabricates a script.
    const row = await db.script.create({
      data: {
        workspaceId,
        channelId,
        approvedIdeaSnapshotId: snapshot.id,
        approvedIdeaChecksum: snapshot.checksumSha256,
        createdByUserId: userId,
        revisions: { create: { revision: 1, document, createdByUserId: userId } },
      },
    });
    const changed = structuredClone(document);
    changed.scenes[0].dialogue = "Persisted targeted change";
    const saved = await scripts.revise(editor, row.id, changed, 1);
    assert.equal(saved.currentRevision, 2);
    assert.deepEqual(saved.revisions[0].document.scenes[1], document.scenes[1]);
    const reordered = structuredClone(changed);
    reordered.scenes.reverse();
    reordered.scenes[0].startSeconds = 0;
    reordered.scenes[1].startSeconds = 10;
    await scripts.revise(editor, row.id, reordered, 2);
    const history = await scripts.revisions(viewer, row.id);
    assert.deepEqual(
      history.items.map((r) => r.revision),
      [3, 2, 1],
    );
    assert.deepEqual(history.items[2].document, document);
    assert.equal(history.items[0].document.scenes[0].id, "two");
    await assert.rejects(() => scripts.revise(viewer, row.id, changed, 3), /permission/);
    await assert.rejects(
      () => scripts.get({ ...owner, workspaceId: foreignWorkspaceId }, row.id),
      /not found/,
    );
    await assert.rejects(() => scripts.revise(editor, row.id, changed, 1), /changed/);
    const candidates = [structuredClone(reordered), structuredClone(reordered)];
    candidates[0].scenes[0].dialogue = "Concurrent editor A";
    candidates[1].scenes[1].dialogue = "Concurrent editor B";
    const outcomes = await Promise.allSettled(
      candidates.map((candidate) => scripts.revise(editor, row.id, candidate, 3)),
    );
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
    assert.equal(outcomes.find((result) => result.status === "rejected").reason.getStatus(), 409);
    assert.equal(await db.scriptRevision.count({ where: { scriptId: row.id } }), 4);
    await assert.rejects(() => scripts.approve(owner, row.id, 3), /changed/);
    assert.notEqual(
      (await db.script.findUniqueOrThrow({ where: { id: row.id } })).status,
      "APPROVED",
    );
    await scripts.approve(owner, row.id, 4);
    assert.equal((await scripts.exportApproved(viewer, row.id)).revision, 4);
    await assert.rejects(() => scripts.revise(editor, row.id, changed, 1), /immutable/);
  });
  console.log(`${passed} actual PostgreSQL persistence scenarios passed; no providers invoked.`);
} finally {
  await db.$disconnect();
}
