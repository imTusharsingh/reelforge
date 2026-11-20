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
    const empty = {
      id: randomUUID(),
      workspaceId: context.workspaceId,
      channelId: request.brief.channelId,
      schemaVersion: "1.0" as const,
      revision: 4,
      character: [],
      scenery: [],
      prop: [],
      style: [],
    };
    await library.setDefaults(context, empty);
    const result = await service.plan(context, request);
    expect(result.manifest.prompts.map((prompt) => prompt.version)).toEqual([2, 2, 2]);
    expect(result.manifest.shots).toHaveLength(6);
    expect(await service.plan(context, request)).toEqual(result);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(images.generate).toHaveBeenCalledTimes(4);
    expect(
      await db.shotSpec.count({
        where: { workspaceId: context.workspaceId, runId: request.runId },
      }),
    ).toBe(6);
    expect(await db.characterVersion.count({ where: { workspaceId: context.workspaceId } })).toBe(
      1,
    );
    const defaults = (await library.defaults(context, request.brief.channelId))!;
    expect(defaults).toMatchObject({ id: empty.id, revision: 5 });
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
  it.each(["absent", "empty"] as const)(
    "serializes initialization and preserves an edit made during image generation with %s defaults",
    async (initial) => {
      const channelId = randomUUID();
      await db.channel.create({
        data: { id: channelId, workspaceId: context.workspaceId, name: "Concurrent" },
      });
      const existing = (await library.defaults(context, request.brief.channelId))!;
      const empty = {
        ...existing,
        id: randomUUID(),
        channelId,
        revision: 7,
        character: [],
        style: [],
      };
      if (initial === "empty") await library.setDefaults(context, empty);
      const edited = { ...empty, revision: 8, style: existing.style };
      const concurrentLibrary = new ReferenceLibraryService(db);
      const prompts = {
        capture: vi.fn().mockResolvedValue({ prompt: "offline prompt", receipt: { version: 2 } }),
      } as unknown as PlanningPromptService;
      const text = {
        generate: vi.fn().mockResolvedValue({
          character: null,
          styleFrame: "Watercolor forest",
          keyframePrompts: Array(6).fill("Watercolor leaves"),
        }),
      };
      const run = { ...request, brief: { ...request.brief, channelId } };
      const characters = new PlanningCharacterService(db);
      const competingImages = { generate: vi.fn() };
      const competitor = new ArtDirectorService(
        text,
        competingImages,
        concurrentLibrary,
        prompts,
        assets,
        characters,
      );
      const images = {
        generate: vi.fn(async () => {
          await expect(competitor.design(context, run, shotsFixture(run))).rejects.toMatchObject({
            status: 409,
            message: "Channel reference initialization in progress",
          });
          await concurrentLibrary.setDefaults(context, edited);
          return { body: png, mediaType: "image/png" as const };
        }),
      };
      const art = new ArtDirectorService(text, images, library, prompts, assets, characters);

      const result = await art.design(context, run, shotsFixture(run));
      expect(images.generate).toHaveBeenCalledTimes(1);
      expect(competingImages.generate).not.toHaveBeenCalled();
      expect(await library.defaults(context, channelId)).toEqual(edited);
      for (const shot of result.shots) expect(shot.references).toEqual(edited.style);
    },
  );
  it("keeps the pool available during image polling and stops dispatch after lock loss", async () => {
    const channelId = randomUUID();
    const run = { ...request, brief: { ...request.brief, channelId } };
    const prompts = {
      capture: vi.fn().mockResolvedValue({ prompt: "offline prompt", receipt: { version: 2 } }),
    } as unknown as PlanningPromptService;
    const text = {
      generate: vi.fn().mockResolvedValue({
        character: { front: "Owl front", side: "Owl side", fullBody: "Owl full body" },
        styleFrame: "Watercolor forest",
        keyframePrompts: Array(6).fill("Watercolor leaves"),
      }),
    };
    const key = `reference-init:${context.workspaceId}:${channelId}`;
    const images = {
      generate: vi.fn(async () => {
        const [session] = await db.$queryRaw<
          { pid: number; state: string; inTransaction: boolean; pooledPid: number }[]
        >`
          SELECT activity.pid, activity.state, activity.xact_start IS NOT NULL AS "inTransaction",
            pg_backend_pid() AS "pooledPid"
          FROM pg_locks AS lock
          JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
          WHERE lock.locktype = 'advisory' AND lock.granted AND lock.objsubid = 1
            AND ((lock.classid::bigint << 32) | lock.objid::bigint) = hashtextextended(${key}, 0)
        `;
        expect(session).toMatchObject({ state: "idle", inTransaction: false });
        if (!session) throw new Error("Expected the reference lock session");
        expect(session.pid).not.toBe(session.pooledPid);
        expect(
          await db.$queryRaw`SELECT pg_terminate_backend(${session.pid}::int, 1000) AS stopped`,
        ).toEqual([{ stopped: true }]);
        return { body: png, mediaType: "image/png" as const };
      }),
    };
    const art = new ArtDirectorService(
      text,
      images,
      library,
      prompts,
      assets,
      new PlanningCharacterService(db),
    );
    await expect(art.design(context, run, shotsFixture(run))).rejects.toMatchObject({
      status: 409,
      message: "Channel reference initialization lock lost",
    });
    expect(images.generate).toHaveBeenCalledTimes(1);
    expect(await library.defaults(context, channelId)).toBeNull();
    await expect(
      library.withInitializationLock(context, channelId, (assertLocked) => assertLocked()),
    ).resolves.toBeUndefined();
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
