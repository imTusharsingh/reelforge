import { BadRequestException } from "@nestjs/common";
import type { z } from "zod";

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
