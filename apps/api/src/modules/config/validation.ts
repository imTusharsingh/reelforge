import { BadRequestException } from "@nestjs/common";
import type { z } from "zod";
import { isUuid } from "../asset/asset.validation.js";

export function parseRequest<T>(schema: z.ZodType<T>, body: unknown, label: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map(
      (issue) =>
        `${issue.path.map((part) => String(part)).join(".") || "<root>"}: ${issue.message}`,
    );
    throw new BadRequestException(`${label} is invalid: ${details.join("; ")}`);
  }
  return parsed.data;
}

export function requireUuid(value: string, field: string): string {
  if (!isUuid(value)) throw new BadRequestException(`${field} must be a UUID`);
  return value;
}

export function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new BadRequestException(`${field} must be a positive integer`);
  return value;
}
