import { expect, it, vi } from "vitest";
import type { PrismaClient } from "./generated/prisma/client.js";
import { seedAllWorkspaceFoundations } from "./foundation-workspace.js";
it("boot seeds each existing workspace through the migration's offline seed", async () => {
  const execute = vi.fn().mockResolvedValue(1);
  const db = {
    workspace: { findMany: vi.fn().mockResolvedValue([{ id: "one" }, { id: "two" }]) },
    $executeRaw: execute,
  } as unknown as PrismaClient;
  await seedAllWorkspaceFoundations(db);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls.map((call) => call[1])).toEqual(["one", "two"]);
});
