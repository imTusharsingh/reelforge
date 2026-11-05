import { z } from "zod";

export const ApiVersionSchema = z.literal("v1");
export type ApiVersion = z.infer<typeof ApiVersionSchema>;

export const CorrelationIdSchema = z.uuid();
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    correlationId: CorrelationIdSchema,
    details: z.array(z.object({ field: z.string().min(1), message: z.string().min(1) })).optional(),
  }).strict(),
}).strict();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const PaginationRequestSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();
export type PaginationRequest = z.infer<typeof PaginationRequestSchema>;

export function paginationResponseSchema<T extends z.ZodType>(
  itemSchema: T,
): z.ZodObject<{ items: z.ZodArray<T>; nextCursor: z.ZodNullable<z.ZodString> }> {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().min(1).nullable(),
  }).strict();
}
