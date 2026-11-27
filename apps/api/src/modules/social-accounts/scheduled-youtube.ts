import {
  SocialProviderError,
  normalizeUploadSession,
  type VerifiedYouTubeVideo,
} from "@reelforge/social-providers";
import type { YouTubeDestinationMetadata } from "@reelforge/contracts";
import { z } from "zod";

export const missedYouTubeSlot = "YOUTUBE_SLOT_MISSED";

export function youTubeSlotElapsed(scheduledAt: Date | string): boolean {
  const instant = typeof scheduledAt === "string" ? Date.parse(scheduledAt) : scheduledAt.getTime();
  return !Number.isFinite(instant) || instant <= Date.now();
}

export function requireFutureYouTubeSlot(scheduledAt: Date | string): void {
  if (youTubeSlotElapsed(scheduledAt)) {
    throw new SocialProviderError({
      kind: "PERMANENT",
      code: missedYouTubeSlot,
      message: "The approved YouTube slot has passed. The upload will not be sent late.",
      retryAfterSeconds: null,
    });
  }
}

/** Uses the existing M12 access token and resumable protocol; no OAuth app or credentials here. */
export class ScheduledYouTube {
  public constructor(private readonly request: typeof fetch = fetch) {}
  public async start(
    token: string,
    metadata: YouTubeDestinationMetadata,
    publishAt: string,
    bytes: number,
    contentType: string,
  ): Promise<string> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || contentType !== "video/mp4")
      throw new Error("Invalid upload media");
    requireFutureYouTubeSlot(publishAt);
    const response = await this.send(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-upload-content-length": String(bytes),
          "x-upload-content-type": contentType,
        },
        body: JSON.stringify({
          snippet: {
            title: metadata.title,
            description: metadata.description,
            tags: metadata.tags ?? [],
            ...(metadata.categoryId ? { categoryId: metadata.categoryId } : {}),
          },
          status: {
            privacyStatus: "private",
            publishAt,
            containsSyntheticMedia: true,
            selfDeclaredMadeForKids: metadata.selfDeclaredMadeForKids,
          },
        }),
      },
    );
    const location = response.headers.get("location");
    if (!location) throw this.failure("UPLOAD_OUTCOME_UNKNOWN", "TRANSIENT");
    return normalizeUploadSession(location, [
      "www.googleapis.com",
      "upload.youtube.com",
      "uploads.gdata.youtube.com",
    ]).sessionUri;
  }
  public async verify(
    token: string,
    videoId: string,
    channelId: string,
    metadata: YouTubeDestinationMetadata,
    publishAt: string,
  ): Promise<VerifiedYouTubeVideo> {
    const response = await this.send(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,status,processingDetails&id=${encodeURIComponent(videoId)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const parsed = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            snippet: z.object({
              channelId: z.string(),
              title: z.string(),
              description: z.string(),
            }),
            status: z.object({
              privacyStatus: z.enum(["private", "public", "unlisted"]),
              uploadStatus: z.string(),
              publishAt: z.string().optional(),
              containsSyntheticMedia: z.boolean(),
            }),
            processingDetails: z.object({ processingStatus: z.string() }).optional(),
          }),
        ),
      })
      .parse(await response.json());
    const video = parsed.items.find((v) => v.id === videoId);
    if (
      !video ||
      video.snippet.channelId !== channelId ||
      video.snippet.title !== metadata.title ||
      video.snippet.description !== metadata.description ||
      !video.status.containsSyntheticMedia
    )
      throw this.failure("SCHEDULED_VIDEO_MISMATCH", "PERMANENT");
    const scheduled =
      video.status.privacyStatus === "private" &&
      video.status.publishAt !== undefined &&
      Date.parse(video.status.publishAt) === Date.parse(publishAt);
    const published =
      video.status.privacyStatus === "public" && Date.now() >= Date.parse(publishAt);
    if (!scheduled && !published) throw this.failure("SCHEDULED_VIDEO_MISMATCH", "PERMANENT");
    return {
      videoId,
      channelId,
      title: video.snippet.title,
      privacyStatus: video.status.privacyStatus,
      uploadStatus: video.status.uploadStatus,
      processingStatus: video.processingDetails?.processingStatus ?? null,
    };
  }
  private async send(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.request(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw this.failure("UPLOAD_OUTCOME_UNKNOWN", "TRANSIENT");
    }
    if (!response.ok)
      throw this.failure(
        response.status === 401 || response.status === 403
          ? "YOUTUBE_RECONNECT_REQUIRED"
          : "YOUTUBE_SCHEDULE_REQUEST_FAILED",
        response.status === 401 || response.status === 403 ? "AUTH_REQUIRED" : "TRANSIENT",
      );
    return response;
  }
  private failure(
    code: string,
    kind: "TRANSIENT" | "PERMANENT" | "AUTH_REQUIRED",
  ): SocialProviderError {
    return new SocialProviderError({ kind, code, message: code, retryAfterSeconds: null });
  }
}
