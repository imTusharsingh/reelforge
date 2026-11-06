import { describe, expect, it } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { ConfigService } from "./config.service.js";
import { PromptService } from "./prompt.service.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const templateId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const versionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const configSnapshotId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const bundleSnapshotId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const workspaceSnapshotId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const checksum = "a".repeat(64);

const context = (role: WorkspaceContext["role"] = "OWNER"): WorkspaceContext => ({
  workspaceId,
  userId: "user-1",
  role,
});

const now = new Date("2026-11-06T12:00:00.000Z");

const templateBody = {
  sections: { instructions: "Write for {{audience}} about {{niche}}." },
  variables: [{ name: "audience" }, { name: "niche" }],
  allowedAdditionSections: ["instructions"],
};

function template(activeVersionId: string | null = versionId): {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: null;
  activeVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
} {
  return {
    id: templateId,
    workspaceId,
    key: "default-video",
    name: "Default video prompt",
    description: null,
    activeVersionId,
    createdAt: now,
    updatedAt: now,
  };
}

function version(
  status: "DRAFT" | "PUBLISHED" = "PUBLISHED",
  versionNumber = 1,
): {
  id: string;
  workspaceId: string;
  templateId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  body: typeof templateBody;
  checksumSha256: string;
  createdByUserId: string;
  publishedAt: Date | null;
  createdAt: Date;
} {
  return {
    id: versionId,
    workspaceId,
    templateId,
    version: versionNumber,
    status,
    body: templateBody,
    checksumSha256: checksum,
    createdByUserId: "user-1",
    publishedAt: status === "PUBLISHED" ? now : null,
    createdAt: now,
  };
}

function readOnlyPromptDatabase(row = template()): Database {
  return {
    promptTemplate: {
      findFirst: async ({ where }: { where: { workspaceId: string; id?: string } }) =>
        where.workspaceId === row.workspaceId ? row : null,
    },
    promptTemplateVersion: {
      findFirst: async ({ where }: { where: { workspaceId: string; templateId: string } }) =>
        where.workspaceId === row.workspaceId && where.templateId === row.id ? version() : null,
    },
    $transaction: () => {
      throw new Error("preview must not write");
    },
    configSnapshot: {
      create: () => {
        throw new Error("preview must not persist config snapshots");
      },
    },
    promptBundleSnapshot: {
      create: () => {
        throw new Error("preview must not persist prompt bundle snapshots");
      },
    },
  } as unknown as Database;
}

describe("PromptService preview and version lifecycle", () => {
  it("previews a deterministic bundle without network calls or writes", async () => {
    const db = readOnlyPromptDatabase();
    const service = new PromptService(db, new ConfigService(db));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("prompt preview must not use the network");
    }) as typeof fetch;

    try {
      const result = (await service.preview(context(), {
        workspaceValues: { identity: { tone: "Warm" } },
        template: { templateId },
      })) as {
        bundle: {
          sections: Record<string, string>;
          variables: Record<string, string>;
          template: { versionId: string; checksumSha256: string };
          fingerprintSha256: string;
        };
      };

      expect(result.bundle.template.versionId).toBe(versionId);
      expect(result.bundle.template.checksumSha256).toBe(checksum);
      expect(result.bundle.sections.system).toContain("Platform system policy");
      expect(result.bundle.sections.instructions).toContain("General audience");
      expect(result.bundle.variables.audience).toBe("General audience");
      expect(result.bundle.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses to edit a published prompt template version", async () => {
    const published = version("PUBLISHED");
    const db = {
      promptTemplate: {
        findFirst: async () => template(),
      },
      promptTemplateVersion: {
        findFirst: async () => published,
        update: () => {
          throw new Error("published versions must not be mutated");
        },
      },
    } as unknown as Database;
    const service = new PromptService(db, new ConfigService(db));

    await expect(
      service.updateVersion(context(), templateId, versionId, templateBody),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rolls a template back to an earlier published version and can reactivate the newer one", async () => {
    const templateRow = template();
    const versions = [
      { ...version("PUBLISHED", 1), id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { ...version("PUBLISHED", 2), id: versionId },
    ];
    const db = {
      promptTemplate: {
        findFirst: async () => templateRow,
        update: async ({ data }: { data: { activeVersionId: string } }) => {
          templateRow.activeVersionId = data.activeVersionId;
          return templateRow;
        },
      },
      promptTemplateVersion: {
        findFirst: async ({ where }: { where: { id?: string; version?: { lt: number } } }) => {
          if (where.id !== undefined) return versions.find((item) => item.id === where.id) ?? null;
          if (where.version?.lt !== undefined)
            return (
              [...versions]
                .filter((item) => item.status === "PUBLISHED" && item.version < where.version!.lt)
                .sort((left, right) => right.version - left.version)[0] ?? null
            );
          return null;
        },
      },
    } as unknown as Database;
    const service = new PromptService(db, new ConfigService(db));

    const rolledBack = await service.rollback(context(), templateId, {});
    expect(rolledBack.id).toBe(versions[0]!.id);
    expect(templateRow.activeVersionId).toBe(versions[0]!.id);

    const activated = await service.activateVersion(context(), templateId, versionId);
    expect(activated.id).toBe(versionId);
    expect(templateRow.activeVersionId).toBe(versionId);
  });

  it("denies a cross-workspace prompt template lookup", async () => {
    const db = readOnlyPromptDatabase();
    const service = new PromptService(db, new ConfigService(db));

    await expect(
      service.getTemplate(
        { workspaceId: otherWorkspaceId, userId: "user-1", role: "OWNER" },
        templateId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("captures configuration and prompt snapshots with exact source IDs", async () => {
    const db = {
      workspace: {
        findFirst: async () => ({ activeConfigSnapshotId: workspaceSnapshotId }),
      },
      workspaceConfigSnapshot: {
        findFirst: async () => ({
          id: workspaceSnapshotId,
          workspaceId,
          version: 1,
          values: {},
          lockedFields: [],
          fingerprintSha256: checksum,
          createdByUserId: "user-1",
          createdAt: now,
        }),
      },
      promptTemplate: {
        findFirst: async () => template(),
      },
      promptTemplateVersion: {
        findFirst: async () => version(),
      },
      configSnapshot: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          id: configSnapshotId,
          createdAt: now,
        }),
      },
      promptBundleSnapshot: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          id: bundleSnapshotId,
          createdAt: now,
        }),
      },
      $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => callback(db),
    } as unknown as Database;
    const service = new PromptService(db, new ConfigService(db));

    const result = (await service.capture(context(), {
      template: { templateId },
      variables: { audience: "Operators" },
    })) as {
      configSnapshot: {
        id: string;
        version: number;
        workspaceConfigSnapshotId: string | null;
        genreId: string | null;
      };
      promptBundleSnapshot: {
        id: string;
        configSnapshotId: string;
        templateId: string;
        templateVersionId: string;
      };
      bundle: { template: { versionId: string }; sections: Record<string, string> };
    };

    expect(result.configSnapshot.id).toBe(configSnapshotId);
    expect(result.configSnapshot.version).toBe(1);
    expect(result.configSnapshot.workspaceConfigSnapshotId).toBe(workspaceSnapshotId);
    expect(result.configSnapshot.genreId).toBeNull();
    expect(result.promptBundleSnapshot.id).toBe(bundleSnapshotId);
    expect(result.promptBundleSnapshot.configSnapshotId).toBe(configSnapshotId);
    expect(result.promptBundleSnapshot.templateId).toBe(templateId);
    expect(result.promptBundleSnapshot.templateVersionId).toBe(versionId);
    expect(result.bundle.template.versionId).toBe(versionId);
    expect(result.bundle.sections.instructions).toContain("Operators");
  });
});
