import type { PrismaClient } from "./generated/prisma/client.js";

export const FOUNDATION_MODELS = [
  "workspaceFoundationDefaults",
  "formatTemplate",
  "channelBrief",
  "videoRun",
  "videoRunStep",
  "shotSpec",
  "providerCapability",
  "runEvent",
  "budgetEnvelope",
  "referenceAsset",
  "channelReferenceDefaults",
] as const;
const protectedModels = new Set(FOUNDATION_MODELS.map((name) => name.toLowerCase()));
type VerifiedWorkspace = Readonly<{
  workspaceId: string;
  userId: string;
  role: "OWNER" | "EDITOR" | "VIEWER";
}>;
const reads = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid scoped arguments");
  return value as Record<string, unknown>;
};
function scopeData(value: unknown, create: boolean, workspaceId: string): unknown {
  const data = object(value);
  if (data.workspaceId !== undefined && data.workspaceId !== workspaceId)
    throw new Error("Cross-workspace write rejected");
  for (const [key, item] of Object.entries(data)) {
    if (
      [
        "document",
        "settings",
        "structure",
        "input",
        "output",
        "error",
        "inputSnapshot",
        "payload",
      ].includes(key)
    )
      continue;
    if (typeof item === "object" && item !== null && !(item instanceof Date))
      throw new Error("Nested writes are not allowed at this boundary");
  }
  return create ? { ...data, workspaceId: workspaceId } : data;
}

/** ADR-003: use only with context verified by WorkspaceService; no raw SQL or nested writes. */
export function foundationWorkspaceGuard(
  db: PrismaClient,
  context: VerifiedWorkspace,
): Pick<PrismaClient, (typeof FOUNDATION_MODELS)[number]> {
  if (!context.workspaceId || !context.userId)
    throw new Error("Verified workspace context required");
  const scoped = db.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }): Promise<unknown> {
          if (!protectedModels.has(model.toLowerCase()))
            throw new Error("Foundation model required");
          const input = object(args);
          if (!reads.has(operation) && context.role === "VIEWER")
            throw new Error("Editor permission required");
          if (input.where !== undefined) {
            const where = object(input.where);
            if (where.workspaceId !== undefined && where.workspaceId !== context.workspaceId)
              throw new Error("Cross-workspace access rejected");
            input.where = { ...where, workspaceId: context.workspaceId };
          } else if (
            reads.has(operation) ||
            operation.startsWith("delete") ||
            operation.startsWith("update")
          ) {
            input.where = { workspaceId: context.workspaceId };
          }
          if (input.data !== undefined)
            input.data = Array.isArray(input.data)
              ? input.data.map((data) => scopeData(data, true, context.workspaceId))
              : scopeData(input.data, operation.startsWith("create"), context.workspaceId);
          if (operation === "upsert") {
            input.create = scopeData(input.create, true, context.workspaceId);
            input.update = scopeData(input.update, false, context.workspaceId);
          }
          return query(args);
        },
      },
    },
  });
  // Expose only guarded delegates; callers cannot escape via a raw-query client.
  return Object.fromEntries(FOUNDATION_MODELS.map((name) => [name, scoped[name]])) as Pick<
    PrismaClient,
    (typeof FOUNDATION_MODELS)[number]
  >;
}

/** Same offline seed used by migration, API boot and workspace creation. */
export async function seedWorkspaceFoundations(
  db: Pick<PrismaClient, "$executeRaw">,
  workspaceId: string,
): Promise<void> {
  await db.$executeRaw`SELECT seed_workspace_foundations(${workspaceId}::uuid)`;
}
export async function seedAllWorkspaceFoundations(db: PrismaClient): Promise<void> {
  const rows = await db.workspace.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  for (const row of rows) await seedWorkspaceFoundations(db, row.id);
}
