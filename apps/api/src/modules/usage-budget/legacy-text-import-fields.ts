import type { Prisma } from "@reelforge/database";
import { z } from "zod";

const object = z.record(z.string(), z.json());
export const legacyObject = (value: unknown): Record<string, Prisma.JsonValue> =>
  object.safeParse(value).data ?? {};

export function keyMatches(payload: unknown, dispatchKey: string): boolean {
  const row = legacyObject(payload);
  const keys = [row.dispatchKey, row.idempotencyKey].filter((key) => key !== undefined);
  return keys.length > 0 && keys.every((key) => key === dispatchKey);
}
