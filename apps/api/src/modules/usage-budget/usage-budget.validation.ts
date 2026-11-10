import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { isValidTimeZone } from "./usage-budget.time.js";
import { MAX_RESERVATION_TTL_MS, USAGE_CATEGORIES } from "./usage-budget.types.js";

const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const currency = z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code");
const timeZone = z.string().min(1).max(64).refine(isValidTimeZone, "invalid IANA timezone");
const reason = z.string().trim().min(3).max(500);

const UpsertBudgetSchema = z
  .object({
    channelId: z.uuid().nullable().optional(),
    currency,
    dailyLimitMinor: minor.nullable().optional(),
    monthlyLimitMinor: minor.nullable().optional(),
    timezone: timeZone.optional(),
    reason,
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.dailyLimitMinor ?? null) !== null || (value.monthlyLimitMinor ?? null) !== null,
    "at least one of dailyLimitMinor or monthlyLimitMinor is required",
  );
export type UpsertBudgetRequest = z.infer<typeof UpsertBudgetSchema>;

const AdjustmentSchema = z
  .object({
    channelId: z.uuid().nullable().optional(),
    kind: z.enum(["CREDIT", "DEBIT"]),
    currency,
    amountMinor: minor.positive(),
    reason,
  })
  .strict();
export type AdjustmentRequest = z.infer<typeof AdjustmentSchema>;

const ReserveSchema = z
  .object({
    channelId: z.uuid().nullable().optional(),
    idempotencyKey: z.string().trim().min(1).max(200),
    category: z.enum(USAGE_CATEGORIES),
    currency,
    amountMinor: minor,
    ttlMs: z.number().int().min(1_000).max(MAX_RESERVATION_TTL_MS).optional(),
    correlationId: z.uuid().optional(),
    workflowRunId: z.uuid().optional(),
    scriptId: z.uuid().optional(),
  })
  .strict();
export type ReserveRequest = z.infer<typeof ReserveSchema>;

const UsageQuerySchema = z
  .object({
    period: z.enum(["DAY", "MONTH"]).default("DAY"),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "invalid date")
      .optional(),
    channelId: z.uuid().optional(),
    timezone: timeZone.optional(),
  })
  .strict();
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

export const parseUpsertBudget = (value: unknown): UpsertBudgetRequest =>
  parse(UpsertBudgetSchema, value);
export const parseAdjustment = (value: unknown): AdjustmentRequest =>
  parse(AdjustmentSchema, value);
export const parseReserve = (value: unknown): ReserveRequest => parse(ReserveSchema, value);
export const parseUsageQuery = (value: unknown): UsageQuery => parse(UsageQuerySchema, value ?? {});
export const parseUsageId = (value: unknown): string => parse(z.uuid(), value);
export const parseActualMinor = (value: unknown): number => parse(minor, value);
