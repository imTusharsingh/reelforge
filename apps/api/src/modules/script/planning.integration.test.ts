import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabaseClient, seedWorkspaceFoundations } from "@reelforge/database";
import { context, planningFixture, scriptFixture, shotsFixture } from "./planning.fixture.js";
import { ReferenceLibraryService } from "../reference-library/reference-library.service.js";
import { PlanningReferenceAssetsService } from "../asset/planning-reference-assets.service.js";
import { PlanningCharacterService } from "../character/planning-character.service.js";
import { LocalFilesystemStorageAdapter } from "../asset/storage/local-storage.adapter.js";
import { ArtDirectorService } from "../character/art-director.service.js";
import { ScriptwriterService, DirectorService } from "./planning-agents.js";
import { PlanningService } from "./planning.service.js";
import type { PlanningPromptService } from "../config/planning-prompt.service.js";
import type { ReferenceAsset } from "@reelforge/contracts";
const url = process.env.DATABASE_URL;
describe.skipIf(!url)("V4 database and storage integration (offline providers)", () => {
  const db = createDatabaseClient(url ?? "postgresql://unused");
  const request = planningFixture();
  const foreign = { ...context, workspaceId: randomUUID() };
  let root = "";
  let assets: PlanningReferenceAssetsService;
  const library = new ReferenceLibraryService(db);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1kAAAAASUVORK5CYII=",
    "base64",
  );
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "v4-planning-"));
    assets = new PlanningReferenceAssetsService(db, new LocalFilesystemStorageAdapter(root));
    await db.user.create({
      data: {
        id: context.userId,
        email: `v4-${context.userId}@example.test`,
      },
    });
    await db.workspace.createMany({
      data: [
        { id: context.workspaceId, name: "Planning" },
        { id: foreign.workspaceId, name: "Foreign" },
      ],
    });
    await db.channel.create({
      data: { id: request.brief.channelId, workspaceId: context.workspaceId, name: "Trees" },
    });
    await seedWorkspaceFoundations(db, context.workspaceId);
    await db.channelBrief.create({
      data: {
        id: request.brief.id,
        workspaceId: context.workspaceId,
        channelId: request.brief.channelId,
        version: 1,
        document: request.brief,
      },
    });
    await db.videoRun.create({
      data: {
        id: request.runId,
        workspaceId: context.workspaceId,
        channelId: request.brief.channelId,
        channelBriefId: request.brief.id,
        channelBriefVersion: 1,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
        inputSnapshot: {},
      },
    });
  });
  afterAll(async () => {
    await db.workspace.deleteMany({
      where: { id: { in: [context.workspaceId, foreign.workspaceId] } },
    });
    await db.user.deleteMany({ where: { id: context.userId } });
    await db.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("plans, persists immutable references/characters/shots and returns pinned manifest", async () => {
    const prompts = {
      format: vi.fn().mockResolvedValue({
        version: 1,
        structure: { opening: "hook", body: "beats", closing: "cta" },
      }),
      capture: vi.fn(async (unused: unknown, unused2: unknown, role: string): Promise<unknown> => ({
        prompt: "offline prompt",
        receipt: {
          role,
          version: 2,
          templateVersionId: randomUUID(),
          promptSnapshotId: randomUUID(),
          configSnapshotId: randomUUID(),
          fingerprintSha256: "a".repeat(64),
        },
      })),
    } as unknown as PlanningPromptService;
    const generate = vi
      .fn()
      .mockResolvedValueOnce(scriptFixture())
      .mockResolvedValueOnce(shotsFixture(request))
      .mockResolvedValueOnce({
        character: {
          front: "Original owl front",
          side: "Original owl side",
          fullBody: "Original owl full body",
        },
        styleFrame: "Watercolor forest",
        keyframePrompts: Array(6).fill("Watercolor leaves"),
      });
    const text = { generate };
    const images = { generate: vi.fn().mockResolvedValue({ body: png, mediaType: "image/png" }) };
    const art = new ArtDirectorService(
      text,
      images,
      library,
      prompts,
      assets,
      new PlanningCharacterService(db),
    );
    const service = new PlanningService(
      db,
      new ScriptwriterService(text, prompts),
      new DirectorService(text, prompts),
      art,
      library,
    );
    const result = await service.plan(context, request);
    expect(result.manifest.prompts.map((prompt) => prompt.version)).toEqual([2, 2, 2]);
    expect(result.manifest.shots).toHaveLength(6);
    expect(
      await db.shotSpec.count({
        where: { workspaceId: context.workspaceId, runId: request.runId },
      }),
    ).toBe(6);
    expect(await db.characterVersion.count({ where: { workspaceId: context.workspaceId } })).toBe(
      1,
    );
    const defaults = (await library.defaults(context, request.brief.channelId))!;
    const refs = await library.resolve(context, [...defaults.character, ...defaults.style]);
    expect(refs).toHaveLength(4);
    expect(refs[0]!.characterVersionId).not.toBeNull();
    await expect(library.resolve(foreign, defaults.character)).rejects.toThrow("not found");
    expect(await library.defaults(foreign, request.brief.channelId)).toBeNull();
    await expect(library.save(foreign, refs[0]!)).rejects.toThrow("Foreign reference");
    await expect(library.setDefaults(foreign, defaults)).rejects.toThrow("Foreign defaults");
    await expect(library.save({ ...context, role: "VIEWER" }, refs[0]!)).rejects.toThrow(
      "Editor permission",
    );
    await expect(
      assets.store({ ...context, role: "VIEWER" }, { body: png, mediaType: "image/png" }),
    ).rejects.toThrow("Editor permission");
    await expect(service.plan(foreign, request)).rejects.toThrow("Owned Brief");
    await expect(service.plan(context, { ...request, runId: randomUUID() })).rejects.toThrow(
      "Run does not match",
    );
  });
  it("verifies stored checksums and reuses content-addressed assets", async () => {
    const first = await assets.store(context, { body: png, mediaType: "image/png" });
    expect(await assets.store(context, { body: png, mediaType: "image/png" })).toEqual(first);
    const bad = new PlanningReferenceAssetsService(db, {
      putObject: vi.fn().mockResolvedValue({ checksumSha256: "bad", byteSize: 0 }),
      getObject: vi.fn(),
      deleteObject: vi.fn(),
    });
    await expect(bad.store(context, { body: png, mediaType: "image/png" })).rejects.toThrow(
      "verification failed",
    );
    const ref: ReferenceAsset = {
      id: randomUUID(),
      workspaceId: context.workspaceId,
      schemaVersion: "1.0",
      referenceId: randomUUID(),
      version: 1,
      kind: "SCENERY",
      source: "UPLOADED",
      name: "Forest",
      assetId: first.assetId,
      assetVersion: first.version,
      characterVersionId: null,
      checksumSha256: first.checksumSha256,
      rights: {
        license: "USER_OWNED",
        rightsHolder: context.workspaceId,
        attestedAt: new Date().toISOString(),
      },
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    await library.save(context, ref);
    expect(
      (await library.resolve(context, [{ referenceAssetId: ref.referenceId, version: 1 }]))[0],
    ).toEqual(ref);
    await expect(
      library.resolve(context, [{ referenceAssetId: ref.referenceId, version: 2 }]),
    ).rejects.toThrow("not found");
  });
});
