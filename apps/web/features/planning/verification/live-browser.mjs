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
  editorId = randomUUID(),
  channelId = randomUUID(),
  otherWorkspace = randomUUID();
const token = randomUUID(),
  viewerToken = randomUUID(),
  editorToken = randomUUID();
const errors = [];
let browser;
try {
  await db.user.createMany({
    data: [ownerId, viewerId, editorId].map((id) => ({ id, email: `${id}@m24-browser.invalid` })),
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
      { userId: editorId, workspaceId, role: "EDITOR" },
    ],
  });
  await db.user.updateMany({
    where: { id: { in: [ownerId, viewerId, editorId] } },
    data: { defaultWorkspaceId: workspaceId },
  });
  await db.session.createMany({
    data: [
      [ownerId, token],
      [viewerId, viewerToken],
      [editorId, editorToken],
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
  await ideas.transition(
    { userId: ownerId, workspaceId, role: "OWNER" },
    approved.id,
    "APPROVED",
    approved.updatedAt,
    approved.status,
  );
  const snapshot = await ideas.getApproved(
    { userId: ownerId, workspaceId, role: "OWNER" },
    approved.id,
  );
  const character = await db.character.create({
    data: {
      workspaceId,
      name: "Mira",
      personality: {},
      voicePreference: {},
      visualInvariants: {},
      variationRules: {},
    },
  });
  const characterVersion = await db.characterVersion.create({
    data: {
      workspaceId,
      characterId: character.id,
      version: 1,
      status: "PUBLISHED",
      profile: {
        name: "Mira",
        description: null,
        personality: {},
        voicePreference: {},
        visualInvariants: {},
        variationRules: {},
      },
      referenceAssets: [],
      checksumSha256: "b".repeat(64),
      publishedAt: new Date(),
    },
  });
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
  const observedIdea = await db.idea.findUniqueOrThrow({ where: { id: created.id } });
  const statusUrl = `${base}/api/v1/workspaces/${workspaceId}/ideas/${created.id}/status`;
  for (const preconditions of [
    { expectedStatus: "BACKLOG", expectedUpdatedAt: observedIdea.updatedAt.toISOString() },
    { expectedStatus: "DRAFT", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" },
  ]) {
    const rejected = await context.request.patch(statusUrl, {
      data: { status: "APPROVED", ...preconditions },
    });
    assert.equal(rejected.status(), 409);
  }
  assert.equal(await db.ideaApprovalSnapshot.count({ where: { ideaId: created.id } }), 0);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Move to backlog", exact: true }).click();
  await page.getByText("BACKLOG", { exact: true }).waitFor();
  const backlog = await db.idea.findUniqueOrThrow({ where: { id: created.id } });
  const intervening = await context.request.patch(
    `${base}/api/v1/workspaces/${workspaceId}/ideas/${created.id}`,
    {
      data: {
        title: backlog.title,
        topic: backlog.topic,
        hook: "Concurrent hook",
        angle: backlog.angle,
        audience: backlog.audience,
        expectedFormat: backlog.expectedFormat,
        channelId,
        references: [],
        sourceNotes: "",
        expectedUpdatedAt: backlog.updatedAt.toISOString(),
      },
    },
  );
  assert.equal(intervening.status(), 200);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Approve idea", exact: true }).click();
  await page.getByText("Compare idea before another action", { exact: true }).waitFor();
  assert.equal(await db.ideaApprovalSnapshot.count({ where: { ideaId: created.id } }), 0);
  await page
    .getByRole("button", { name: "Use refreshed brief for next action", exact: true })
    .click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Approve idea", exact: true }).click();
  await page.getByRole("heading", { name: "Immutable approval snapshot", exact: true }).waitFor();
  await page
    .getByLabel("Schedule for", { exact: true })
    .fill(new Date(Date.now() + 3600000).toISOString().slice(0, 16));
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Schedule idea", exact: true }).click();
  await page.getByText("SCHEDULED", { exact: true }).waitFor();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Reject idea", exact: true }).click();
  await page.getByText("REJECTED", { exact: true }).waitFor();
  assert.equal(await db.ideaApprovalSnapshot.count({ where: { ideaId: created.id } }), 1);
  console.log(
    "PASS real atomic idea lifecycle, stale timestamp/status rejection and explicit 409 resolution",
  );
  const editorContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: "UTC",
  });
  await editorContext.addCookies([
    {
      name: "reelforge_session",
      value: editorToken,
      url: base,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const editorPage = await editorContext.newPage();
  editorPage.on("pageerror", (e) => errors.push(e.message));
  await editorPage.goto(`${base}/planning/scripts/${script.id}`);
  await editorPage.getByRole("button", { name: /M24 Browser Studio/ }).click();
  await editorPage.getByLabel("Scene dialogue", { exact: true }).waitFor();
  await page.goto(`${base}/planning/scripts/${script.id}`);
  await page.getByLabel("Scene dialogue", { exact: true }).fill("Owner targeted scene edit");
  await page.getByLabel("Scene character", { exact: true }).selectOption(character.id);
  await page
    .getByLabel("Published scene character version", { exact: true })
    .selectOption(characterVersion.id);
  await page.getByRole("button", { name: "Assign published character", exact: true }).click();
  await page.getByRole("button", { name: "Save script revision", exact: true }).click();
  await page.getByText("Revision 2 saved by the server.", { exact: true }).waitFor();
  const second = await db.scriptRevision.findFirstOrThrow({
    where: { scriptId: script.id, revision: 2 },
  });
  assert.deepEqual(second.document.scenes[1], document.scenes[1]);
  assert.deepEqual(second.document.scenes[0].characterRefs, [
    { characterId: character.id, versionId: characterVersion.id },
  ]);
  console.log(
    "PASS targeted revision and published character reference persist without altering unrelated scene",
  );
  await editorPage.getByRole("button", { name: "Scene 2 · 10s", exact: true }).click();
  await editorPage
    .getByLabel("Scene dialogue", { exact: true })
    .fill("Editor targeted second scene");
  await editorPage.getByRole("button", { name: "Save script revision", exact: true }).click();
  await editorPage.getByText("Compare server and working draft", { exact: true }).waitFor();
  assert.equal(
    await editorPage.getByLabel("Scene dialogue", { exact: true }).inputValue(),
    "Editor targeted second scene",
  );
  assert.equal(await db.scriptRevision.count({ where: { scriptId: script.id } }), 2);
  await editorPage
    .getByRole("button", { name: "Rebase non-conflicting edits", exact: true })
    .click();
  await editorPage.getByRole("button", { name: "Save script revision", exact: true }).click();
  await editorPage.getByText("Revision 3 saved by the server.", { exact: true }).waitFor();
  const third = await db.scriptRevision.findFirstOrThrow({
    where: { scriptId: script.id, revision: 3 },
  });
  assert.equal(third.document.scenes[0].dialogue, "Owner targeted scene edit");
  assert.equal(third.document.scenes[1].dialogue, "Editor targeted second scene");
  console.log(
    "PASS two authenticated editors: stale revision 409 retains draft, explicit rebase preserves both edits",
  );
  await editorPage.getByRole("button", { name: "Move scene earlier", exact: true }).click();
  await editorPage.getByLabel("Scene duration (seconds)", { exact: true }).fill("12");
  await editorPage.getByRole("button", { name: "Reflow scene starts", exact: true }).click();
  await editorPage.getByRole("button", { name: "Use scene total as target", exact: true }).click();
  await editorPage.getByRole("button", { name: "Save script revision", exact: true }).click();
  await editorPage.getByText("Revision 4 saved by the server.", { exact: true }).waitFor();
  const fourth = await db.scriptRevision.findFirstOrThrow({
    where: { scriptId: script.id, revision: 4 },
  });
  assert.deepEqual(
    fourth.document.scenes.map((scene) => [scene.id, scene.startSeconds, scene.durationSeconds]),
    [
      ["second", 0, 12],
      ["first", 12, 10],
    ],
  );
  console.log("PASS scene order, timing, target duration and unchanged character pins persist");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Approve saved script", exact: true }).click();
  await page.getByText("Compare server and working draft", { exact: true }).waitFor();
  assert.notEqual(
    (await db.script.findUniqueOrThrow({ where: { id: script.id } })).status,
    "APPROVED",
  );
  await page.getByRole("button", { name: "Use latest saved revision", exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Approve saved script", exact: true }).click();
  await page.getByText("Inspect approved export revision 4", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Inspect approved export revision 4", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Scene dialogue", { exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "Inspect revision 1", exact: true }).waitFor();
  const approvedExportResponse = await context.request.get(
    `${base}/api/v1/workspaces/${workspaceId}/scripts/${script.id}/export`,
  );
  assert.equal(approvedExportResponse.status(), 200);
  assert.equal((await approvedExportResponse.json()).revision, 4);
  await page.screenshot({ path: "/tmp/m24-live-desktop.png", fullPage: true });
  console.log(
    "PASS stale approval cannot approve unseen revision; explicit revision 4 approval/export/reload is immutable",
  );
  await page.goto(`${base}/planning/ideas/${approved.id}`);
  await page.getByText("Script generation is not configured", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Generate script", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await page.getByLabel("Title", { exact: true }).isDisabled(), true);
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
    { data: { expectedRevision: 4, document } },
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
  const recoveryResponse = await context.request.post(
    `${base}/api/v1/workspaces/${workspaceId}/ideas`,
    {
      data: {
        title: "Recovery fixture",
        topic: randomUUID(),
        hook: "Opening",
        angle: "Perspective",
        audience: "Creators",
        channelId,
        references: [],
        sourceNotes: "",
        expectedFormat: "short-form-video",
      },
    },
  );
  assert.equal(recoveryResponse.status(), 201);
  const recoveryIdea = await recoveryResponse.json();
  const recoveryUrl = `${base}/api/v1/workspaces/${workspaceId}/ideas/${recoveryIdea.id}`;
  await page.goto(`${base}/planning/ideas/${recoveryIdea.id}`);
  let writeAttempts = 0;
  await page.route(recoveryUrl, async (route) => {
    if (route.request().method() === "PATCH") {
      writeAttempts++;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByLabel("Title", { exact: true }).fill("Committed response-lost brief");
  await page.getByRole("button", { name: "Save brief", exact: true }).click();
  await page.getByText("Reconcile an interrupted save", { exact: true }).waitFor();
  const confirmRecovery = page.getByRole("button", {
    name: "I have compared the fetched saved state",
    exact: true,
  });
  assert.equal(await confirmRecovery.isDisabled(), true);
  const readsUrl = `${base}/api/v1/workspaces/${workspaceId}/ideas?**`;
  await page.route(readsUrl, (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Fetch affected saved resource", exact: true }).click();
  await page.getByText(/Reconciliation failed:/).waitFor();
  assert.equal(await confirmRecovery.isDisabled(), true);
  await page.unroute(readsUrl);
  await page.getByRole("button", { name: "Fetch affected saved resource", exact: true }).click();
  await page.getByText(`Fetched saved state: Idea ${recoveryIdea.id}`, { exact: true }).waitFor();
  assert(
    (await page.locator("details pre").first().textContent()).includes(
      "Committed response-lost brief",
    ),
  );
  await confirmRecovery.click();
  assert.equal(
    await page.evaluate(
      (id) => sessionStorage.getItem(`reelforge.planning.pending:${id}`),
      workspaceId,
    ),
    null,
  );
  assert.equal(writeAttempts, 1);
  assert.equal(
    (await db.idea.findUniqueOrThrow({ where: { id: recoveryIdea.id } })).title,
    "Committed response-lost brief",
  );
  await page.unroute(recoveryUrl);
  if (await page.getByRole("button", { name: "Use saved brief", exact: true }).count()) {
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Use saved brief", exact: true }).click();
  }
  console.log(
    "PASS real committed write with lost response: failed read stays blocked; successful comparison recovers without replay",
  );
  await page.getByRole("link", { name: "Operations", exact: true }).first().click();
  await page.waitForURL("**/operations");
  await page.getByRole("link", { name: "Channels", exact: true }).first().click();
  await page.waitForURL("**/channels");
  await page.getByRole("link", { name: "Overview", exact: true }).first().click();
  await page.waitForURL(base + "/");
  assert.deepEqual(errors, []);
  console.log("PASS Overview, Channels and Operations navigation preserved; no page errors");
  console.log("11 live browser integration scenarios passed; no provider requests.");
} finally {
  await browser?.close();
  await db.$disconnect();
}
