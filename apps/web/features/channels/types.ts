import type { ApiRecord, Channel } from "../../lib/api";

export type ChannelWorkspaceData = {
  channel: Channel;
  genres: ApiRecord[];
  series: ApiRecord[];
  characters: ApiRecord[];
  assets: ApiRecord[];
  config: ApiRecord | null;
  snapshots: ApiRecord[];
  prompts: ApiRecord[];
};

export function text(value: unknown, fallback = "Not provided"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function id(value: unknown): string {
  return typeof value === "string" ? value : "";
}
