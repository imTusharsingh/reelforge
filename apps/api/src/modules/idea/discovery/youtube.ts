import { Injectable } from "@nestjs/common";
import { z } from "zod";
import type { DiscoverySource } from "./types.js";
import { DiscoveryQuotaService } from "./quota.js";

const SearchSchema = z.object({
  items: z.array(
    z.object({
      id: z.object({ videoId: z.string().min(1) }),
      snippet: z.object({ title: z.string().min(1).max(300) }),
    }),
  ),
});
const ChartsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      snippet: z.object({ title: z.string().min(1).max(300) }),
    }),
  ),
});
@Injectable()
export class DiscoveryYouTube {
  public constructor(private readonly quotas: DiscoveryQuotaService) {}
  public async sources(workspaceId: string, query: string, now: Date): Promise<DiscoverySource[]> {
    const key = process.env.NODE_ENV === "test" ? undefined : process.env.YOUTUBE_DATA_API_KEY;
    if (!key) return [];
    const charts = await this.get(
      "videos",
      { chart: "mostPopular", part: "snippet", maxResults: "10" },
      key,
    );
    const result: DiscoverySource[] = ChartsSchema.parse(charts).items.map((item) => ({
      kind: "YOUTUBE",
      title: item.snippet.title,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(item.id)}`,
    }));
    if (!(await this.quotas.reserve(workspaceId, "youtube", now))) return result;
    const search = await this.get(
      "search",
      { q: query, part: "snippet", type: "video", order: "date", maxResults: "10" },
      key,
    );
    return [
      ...result,
      ...SearchSchema.parse(search).items.map((item): DiscoverySource => ({
        kind: "YOUTUBE",
        title: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(item.id.videoId)}`,
      })),
    ];
  }
  private async get(
    resource: string,
    query: Record<string, string>,
    key: string,
  ): Promise<unknown> {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
    url.search = new URLSearchParams(query).toString();
    const response = await fetch(url, {
      headers: { "X-Goog-Api-Key": key },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`YouTube discovery failed (${response.status})`);
    return response.json() as Promise<unknown>;
  }
}
