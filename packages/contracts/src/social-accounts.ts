import { z } from "zod";

export const SocialPlatformSchema = z.enum(["YOUTUBE", "INSTAGRAM"]);
export type SocialPlatform = z.infer<typeof SocialPlatformSchema>;

export const SocialAccountStatusSchema = z.enum([
  "CONNECTED",
  "REAUTH_REQUIRED",
  "REVOCATION_PENDING",
  "REVOCATION_FAILED",
  "REVOKED",
]);
export type SocialAccountStatus = z.infer<typeof SocialAccountStatusSchema>;

export const SocialAccountHealthSchema = z.enum(["HEALTHY", "AUTH_REQUIRED", "UNAVAILABLE"]);
export type SocialAccountHealth = z.infer<typeof SocialAccountHealthSchema>;

export const SocialPermissionStatusSchema = z.enum(["GRANTED", "NOT_GRANTED"]);
export type SocialPermissionStatus = z.infer<typeof SocialPermissionStatusSchema>;

export const SocialAccountPermissionSchema = z
  .object({
    permission: z.string().min(1),
    status: SocialPermissionStatusSchema,
  })
  .strict();
export type SocialAccountPermission = z.infer<typeof SocialAccountPermissionSchema>;

export const SocialAccountCapabilitySchema = z
  .object({
    capability: z.string().min(1),
    enabled: z.boolean(),
    details: z.record(z.string(), z.unknown()).nullable(),
    checkedAt: z.iso.datetime(),
  })
  .strict();
export type SocialAccountCapability = z.infer<typeof SocialAccountCapabilitySchema>;

export const SocialAccountSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    channelId: z.uuid(),
    platform: SocialPlatformSchema,
    remoteAccountId: z.string().min(1),
    displayName: z.string().min(1),
    username: z.string().nullable(),
    status: SocialAccountStatusSchema,
    health: SocialAccountHealthSchema,
    connectedAt: z.iso.datetime(),
    lastHealthCheckAt: z.iso.datetime().nullable(),
    permissions: z.array(SocialAccountPermissionSchema),
    capabilities: z.array(SocialAccountCapabilitySchema),
  })
  .strict();
export type SocialAccount = z.infer<typeof SocialAccountSchema>;

export const SocialPlatformErrorSchema = z
  .object({
    kind: z.enum([
      "NOT_CONFIGURED",
      "AUTH_REQUIRED",
      "PERMISSION_DENIED",
      "RATE_LIMITED",
      "TRANSIENT",
      "PERMANENT",
    ]),
    code: z.string().min(1),
    message: z.string().min(1),
    retryAfterSeconds: z.number().int().positive().nullable(),
  })
  .strict();
export type SocialPlatformError = z.infer<typeof SocialPlatformErrorSchema>;

export const RemoteMediaIdSchema = z.string().min(1).max(255);
export type RemoteMediaId = z.infer<typeof RemoteMediaIdSchema>;
