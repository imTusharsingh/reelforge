import { z } from "zod";

/**
 * C5/M22 account contracts. Identity bodies are strict: unknown keys (including `email` on profile
 * edits) are rejected. Password reset is deferred (no delivery port); these schemas cover profile
 * reads/edits and password changes only.
 */

export const AuthMeResponseSchema = z
  .object({
    userId: z.uuid(),
    email: z.email(),
    displayName: z.string().nullable(),
  })
  .strict();
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;

export const UpdateAuthMeRequestSchema = z
  .object({
    displayName: z.string(),
  })
  .strict();
export type UpdateAuthMeRequest = z.infer<typeof UpdateAuthMeRequestSchema>;

export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().max(1024),
    newPassword: z.string().max(1024),
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const ChangePasswordResponseSchema = z
  .object({
    ok: z.literal(true),
    revokedSessions: z.number().int().nonnegative(),
  })
  .strict();
export type ChangePasswordResponse = z.infer<typeof ChangePasswordResponseSchema>;
