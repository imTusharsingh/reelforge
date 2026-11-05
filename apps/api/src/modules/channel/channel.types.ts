export type JsonValue = string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type ChannelStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";
export type ChannelInput = Readonly<{
  name: string;
  handle?: string;
  description?: string;
  niche?: string;
  language?: string;
  audience?: string;
  timezone?: string;
  goals?: JsonValue;
  schedule?: JsonValue;
  automationDefaults?: JsonValue;
  approvalPolicy?: JsonValue;
  publishingDestinations?: JsonValue;
}>;
export type ChannelPatch = Partial<ChannelInput>;
export type ChannelSummary = Readonly<{
  id: string;
  workspaceId: string;
  name: string;
  status: ChannelStatus;
}>;
