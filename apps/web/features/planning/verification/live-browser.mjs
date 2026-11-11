/** Opt-in real Next + API + disposable PostgreSQL browser integration. No paid calls. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createDatabaseClient } from "../../../../../packages/database/dist/index.js";
import { IdeaService } from "../../../../api/dist/modules/idea/idea.service.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const url = process.env.M24_TEST_DATABASE_URL;
const base = process.env.M24_TEST_WEB_ORIGIN || "http://127.0.0.1:3000";
if (
  !url ||
  !/^postgresql:\/\/[^/]*@(127\.0\.0\.1|localhost):/.test(url) ||
  !url.includes("reelforge_dev") ||
  !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)
)
  throw new Error("Requires disposable localhost database and web origin");
const db = createDatabaseClient(url);
const workspaceId = randomUUID(),
  ownerId = randomUUID(),
  viewerId = randomUUID(),
  channelId = randomUUID(),
  otherWorkspace = randomUUID();
const token = randomUUID(),
  viewerToken = randomUUID();
const errors = [];
let browser;
try {
  await db.user.createMany({
    data: [ownerId, viewerId].map((id) => ({ id, email: `${id}@m24-browser.invalid` })),
  });
  await db.workspace.createMany({
    data: [
      { id: workspaceId, name: "M24 Browser Studio" },
      { id: otherWorkspace, name: "Foreign studio" },
    ],
  });
  await db.workspaceMembership.createMany({
    data: [
      { userId: ownerId, workspaceId, role: "OWNER" },
      { userId: viewerId, workspaceId, role: "VIEWER" },
    ],
  });
  await db.user.updateMany({
    where: { id: { in: [ownerId, viewerId] } },
    data: { defaultWorkspaceId: workspaceId },
  });
  await db.session.createMany({
    data: [
      [ownerId, token],
      [viewerId, viewerToken],
    ].map(([userId, secret]) => ({
      userId,
      tokenHash: createHash("sha256").update(secret).digest("hex"),
      expiresAt: new Date(Date.now() + 3600000),
    })),
  });
  await db.channel.create({ data: { id: channelId, workspaceId, name: "Planning channel" } });
  await db.genre.create({
    data: {
      workspaceId,
      name: "Browser education",
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
  const ideas = new IdeaService(db, {
    proposeIdea: async () => {
      throw new Error("Providers forbidden");
    },
  });
  const approved = await ideas.create(
    { userId: ownerId, workspaceId, role: "OWNER" },
    {
      title: "Approved browser fixture",
      topic: randomUUID(),
      hook: "Opening",
      angle: "Perspective",
      audience: "Creators",
      references: [],
      sourceNotes: "",
      expectedFormat: "short-form-video",
      channelId,
    },
    "USER",
  );
  await ideas.transition({ userId: ownerId, workspaceId, role: "OWNER" }, approved.id, "APPROVED");
  const snapshot = await ideas.getApproved(
    { userId: ownerId, workspaceId, role: "OWNER" },
    approved.id,
  );
  const document = {
    schemaVersion: "1.0",
    title: "Live planning storyboard",
    hook: "Opening",
    dialogue: "",
    cta: "Try it",
    metadata: { genre: "Browser education", targetDurationSeconds: 20, factual: false },
    scenes: [
      {
        id: "first",
        startSeconds: 0,
        durationSeconds: 10,
        characterRefs: [],
        dialogue: "First scene",
        visualDescription: "Morning desk",
        camera: "Close",
        audioCues: [],
      },
      {
        id: "second",
        startSeconds: 10,
        durationSeconds: 10,
        characterRefs: [],
        dialogue: "Unrelated second scene",
        visualDescription: "Notebook",
        camera: "Wide",
        audioCues: [],
      },
    ],
  };
  const script = await db.script.create({
    data: {
      workspaceId,
      channelId,
      approvedIdeaSnapshotId: snapshot.id,
      approvedIdeaChecksum: snapshot.checksumSha256,
      createdByUserId: ownerId,
      revisions: { create: { revision: 1, document, createdByUserId: ownerId } },
    },
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([
    { name: "reelforge_session", value: token, url: base, httpOnly: true, sameSite: "Strict" },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/planning`);
  await page.getByRole("button", { name: /M24 Browser Studio/ }).click();
  await page.getByRole("heading", { name: "Ideas, scripts & storyboard" }).waitFor();
  for (const [label, value] of [
    ["Title", "Live creator brief"],
    ["Topic", "A small habit"],
    ["Opening hook", "Start today"],
    ["Editorial angle", "One minute"],
    ["Audience", "Creators"],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByLabel("Idea channel", { exact: true }).selectOption(channelId);
  await page.getByRole("button", { name: "Create idea", exact: true }).click();
  await page.getByText("Idea saved by the server.", { exact: true }).waitFor();
  const created = await db.idea.findFirstOrThrow({
    where: { workspaceId, title: "Live creator brief" },
  });
  assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), "");
  await page.goto(`${base}/planning/ideas/${created.id}`);
  await page.getByLabel("Title", { exact: true }).fill("Persisted browser brief");
  await page.getByRole("button", { name: "Save brief", exact: true }).click();
  await page.getByText("Idea saved by the server.", { exact: true }).waitFor();
  await page.reload();
  assert.equal(
    await page.getByLabel("Title", { exact: true }).inputValue(),
    "Persisted browser brief",
  );
  await page.getByLabel("Title", { exact: true }).fill("Local concurrent brief");
  const currentIdea = await db.idea.findUniqueOrThrow({ where: { id: created.id } });
  const concurrent = await context.request.patch(
    `${base}/api/v1/workspaces/${workspaceId}/ideas/${created.id}`,
    {
      data: {
        title: "Other editor brief",
        topic: currentIdea.topic,
        hook: currentIdea.hook,
        angle: currentIdea.angle,
        audience: currentIdea.audience,
        expectedFormat: currentIdea.expectedFormat,
        references: [],
        sourceNotes: "",
        channelId,
        expectedUpdatedAt: currentIdea.updatedAt.toISOString(),
      },
    },
  );
  assert.equal(concurrent.status(), 200);
  await page.getByRole("button", { name: "Save brief", exact: true }).click();
  await page.getByText("Compare a newer saved brief", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Title", { exact: true }).inputValue(),
    "Local concurrent brief",
  );
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Keep my draft against latest brief", exact: true })
    .click();
  await page.getByRole("button", { name: "Save brief", exact: true }).click();
  await page.getByText("Idea saved by the server.", { exact: true }).waitFor();
  console.log(
    "PASS actual HTTP 409 preserves draft and requires explicit comparison and resubmission",
  );
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Archive idea", exact: true }).click();
  await page.getByRole("button", { name: "Restore idea", exact: true }).waitFor();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Restore idea", exact: true }).click();
  await page.getByRole("button", { name: "Archive idea", exact: true }).waitFor();
  console.log("PASS real Next/M06 create, edit, reload, archive and restore");
  await page.goto(`${base}/planning/scripts/${script.id}`);
  await page
    .getByLabel("Scene dialogue", { exact: true })
    .fill("Local draft while Core release gate is closed");
  assert.equal(
    await page.getByRole("button", { name: "Save script revision", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Approve saved script", exact: true }).isDisabled(),
    true,
  );
  const persisted = await db.scriptRevision.findFirstOrThrow({
    where: { workspaceId, scriptId: script.id, revision: 1 },
  });
  assert.deepEqual(persisted.document, document);
  await page.getByRole("button", { name: "Scene 2 · 10s", exact: true }).click();
  assert.equal(
    await page.getByLabel("Scene dialogue", { exact: true }).inputValue(),
    "Unrelated second scene",
  );
  await page.screenshot({ path: "/tmp/m24-live-desktop.png", fullPage: true });
  console.log(
    "PASS script local drafts stay editable while unsafe revision and approval writes are disabled",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.goto(`${base}/planning/ideas/${approved.id}`);
  await page.getByText("Script generation is not configured", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Generate script", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByLabel("Title", { exact: true }).isDisabled(), true);
  assert.equal(
    await page.getByRole("button", { name: "Schedule idea", exact: true }).isDisabled(),
    true,
  );
  console.log("PASS approved brief is locked and unconfigured generation cannot dispatch");
  const viewer = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await viewer.addCookies([
    {
      name: "reelforge_session",
      value: viewerToken,
      url: base,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const readOnly = await viewer.newPage();
  await readOnly.goto(`${base}/planning/scripts/${script.id}`);
  await readOnly.getByRole("button", { name: /M24 Browser Studio/ }).click();
  assert.equal(await readOnly.getByLabel("Scene dialogue", { exact: true }).isDisabled(), true);
  assert.equal(
    await readOnly.getByRole("button", { name: "Save script revision", exact: true }).isDisabled(),
    true,
  );
  const denied = await viewer.request.post(
    `${base}/api/v1/workspaces/${workspaceId}/scripts/${script.id}/revisions`,
    { data: document },
  );
  assert.equal(denied.status(), 403);
  const foreign = await context.request.get(
    `${base}/api/v1/workspaces/${otherWorkspace}/scripts/${script.id}`,
  );
  assert.equal(foreign.status(), 403);
  assert(await readOnly.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await readOnly.screenshot({ path: "/tmp/m24-live-mobile.png", fullPage: true });
  console.log(
    "PASS verified viewer UI, HTTP 403 write enforcement, tenant isolation and mobile layout",
  );
  await page.getByRole("link", { name: "Operations", exact: true }).first().click();
  await page.waitForURL("**/operations");
  await page.getByRole("link", { name: "Channels", exact: true }).first().click();
  await page.waitForURL("**/channels");
  await page.getByRole("link", { name: "Overview", exact: true }).first().click();
  await page.waitForURL(base + "/");
  assert.deepEqual(errors, []);
  console.log("PASS Overview, Channels and Operations navigation preserved; no page errors");
  console.log("6 live browser integration scenarios passed; no provider requests.");
} finally {
  await browser?.close();
  await db.$disconnect();
}
