import { BadRequestException } from "@nestjs/common";
import { SocialPlatformSchema } from "@reelforge/contracts";
import { z } from "zod";

const startConnectionSchema = z
  .object({
    remoteAccountId: z.string().trim().min(1).max(255),
  })
  .strict();

const callbackQuerySchema = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z.string().min(1).max(2048).optional(),
    error: z.string().min(1).max(100).optional(),
    error_description: z.string().max(512).optional(),
    error_uri: z.url().max(2048).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.code === undefined
        ? value.error !== undefined
        : value.error === undefined &&
          value.error_description === undefined &&
          value.error_uri === undefined,
    {
      message: "OAuth callback must contain either code or error.",
    },
  );

export type StartConnectionRequest = z.infer<typeof startConnectionSchema>;
export type OAuthCallbackQuery = z.infer<typeof callbackQuerySchema>;

export function requireYouTubeCallbackUrl(callback: string | undefined): string {
  const url = callback ? URL.parse(callback) : null;
  const parts = url?.pathname.split("/");
  if (
    !callback ||
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    !parts ||
    parts.length !== 7 ||
    parts.slice(0, 5).join("/") !== "/api/v1/social-accounts/oauth" ||
    parts[5]?.toLowerCase() !== "youtube" ||
    parts[6] !== "callback"
  ) {
    throw new Error(
      "YOUTUBE_OAUTH_CALLBACK_URL must be an HTTP(S) URL with path /api/v1/social-accounts/oauth/youtube/callback",
    );
  }
  return callback;
}

export function parsePlatform(value: unknown): z.infer<typeof SocialPlatformSchema> {
  const parsed = SocialPlatformSchema.safeParse(
    typeof value === "string" ? value.toUpperCase() : value,
  );
  if (!parsed.success) throw new BadRequestException("Unsupported social platform");
  return parsed.data;
}

export function parseStartConnection(body: unknown): StartConnectionRequest {
  const parsed = startConnectionSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException("Invalid social account connection request");
  return parsed.data;
}

export function parseOAuthCallback(query: unknown): OAuthCallbackQuery {
  const parsed = callbackQuerySchema.safeParse(query);
  if (!parsed.success) throw new BadRequestException("Invalid OAuth callback");
  return parsed.data;
}
