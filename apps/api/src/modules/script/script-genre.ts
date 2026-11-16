import { ConflictException } from "@nestjs/common";
import type { Database } from "../identity/identity.types.js";

/** V1 removes the required genre choice; preserve configured policies and tenant scope. */
export async function resolveScriptGenre(
  db: Database,
  workspaceId: string,
  name: string,
): Promise<{ id: string; safetyProfile: unknown }> {
  const select = { id: true, safetyProfile: true } as const;
  const requested = await db.genre.findFirst({
    where: { workspaceId, name: { equals: name.trim(), mode: "insensitive" } },
    select,
  });
  if (requested) return requested;
  const fallback = await db.genre.findFirst({
    where: { workspaceId, name: { equals: "Explainer", mode: "insensitive" } },
    select,
  });
  if (!fallback)
    throw new ConflictException("Default genre is missing; restore the workspace seed");
  return fallback;
}
