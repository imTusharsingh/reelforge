function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const platformValues = ["YOUTUBE", "INSTAGRAM"] as const;
type Platform = (typeof platformValues)[number];
export type Channel = { id: string; workspaceId: string; name: string; status: string };
export type PlatformAvailability = {
  platform: Platform;
  connectable: boolean;
  publishable: boolean;
  reasonCode: string | null;
};
export type SocialAccount = {
  id: string;
  workspaceId: string;
  channelId: string;
  platform: Platform;
  remoteAccountId: string;
  displayName: string;
  username: string | null;
  status: string;
  health: string;
  connectedAt: string;
};
type Destination = {
  id: string;
  platform: Platform;
  socialAccountId: string;
  status: string;
  remotePostId: string | null;
  publishedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  latestAttempt: {
    id: string;
    attemptNumber: number;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
  } | null;
};
export type Post = {
  dryRun?: boolean;
  id: string;
  channelId: string;
  renderJobId: string;
  qualityReviewRunId: string;
  revision: number;
  scheduledAt: string | null;
  status: string;
  disclosureDecision: "DISCLOSE" | "NOT_REQUIRED";
  disclosureText: string | null;
  disclosureReason: string;
  createdAt: string;
  updatedAt: string;
  destinations: Destination[];
};
export type PublishedRecord = {
  workspaceId: string;
  channelId: string;
  scheduledPostId: string;
  destinationId: string;
  renderJobId: string;
  platform: Platform;
  platformPostId: string;
  publishedAt: string;
};
function invalid(message = "The publishing service returned invalid or mismatched data."): never {
  throw new Error(message);
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid();
  return value;
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}
function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid();
  return Number(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalid();
  return value;
}
function platform(value: unknown): Platform {
  if (!platformValues.includes(value as Platform)) invalid();
  return value as Platform;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid();
  return value as T;
}

export function parseChannels(value: unknown, workspaceId: string): Channel[] {
  if (!Array.isArray(value)) invalid();
  return value.map((item) => {
    const row = record(item);
    if (row.workspaceId !== workspaceId) invalid();
    return {
      id: text(row.id),
      workspaceId,
      name: text(row.name),
      status: text(row.status),
    };
  });
}

export function parsePlatforms(value: unknown): PlatformAvailability[] {
  if (!Array.isArray(value)) invalid();
  return value.map((item) => {
    const row = record(item);
    return {
      platform: platform(row.platform),
      connectable: boolean(row.connectable),
      publishable: boolean(row.publishable),
      reasonCode: nullableText(row.reasonCode),
    };
  });
}

export function parseAccounts(value: unknown, workspaceId: string): SocialAccount[] {
  if (!Array.isArray(value)) invalid();
  return value.map((item) => {
    const row = record(item);
    if (row.workspaceId !== workspaceId) invalid();
    return {
      id: text(row.id),
      workspaceId,
      channelId: text(row.channelId),
      platform: platform(row.platform),
      remoteAccountId: text(row.remoteAccountId),
      displayName: text(row.displayName),
      username: nullableText(row.username),
      status: text(row.status),
      health: text(row.health),
      connectedAt: timestamp(row.connectedAt),
    };
  });
}

function parseDestination(value: unknown): Destination {
  const row = record(value);
  const attempt = row.latestAttempt;
  return {
    id: text(row.id),
    platform: platform(row.platform),
    socialAccountId: text(row.socialAccountId),
    status: text(row.status),
    remotePostId: nullableText(row.remotePostId),
    publishedAt: nullableTimestamp(row.publishedAt),
    lastErrorCode: nullableText(row.lastErrorCode),
    lastErrorMessage: nullableText(row.lastErrorMessage),
    latestAttempt:
      attempt === null
        ? null
        : ((): NonNullable<Destination["latestAttempt"]> => {
            const value = record(attempt);
            return {
              id: text(value.id),
              attemptNumber: integer(value.attemptNumber, 1),
              status: text(value.status),
              errorCode: nullableText(value.errorCode),
              errorMessage: nullableText(value.errorMessage),
            };
          })(),
  };
}

export function parsePost(value: unknown, expectedId?: string): Post {
  const row = record(value);
  const id = text(row.id);
  if (expectedId !== undefined && id !== expectedId) invalid();
  if (!Array.isArray(row.destinations)) invalid();
  return {
    id,
    channelId: text(row.channelId),
    renderJobId: text(row.renderJobId),
    qualityReviewRunId: text(row.qualityReviewRunId),
    revision: integer(row.revision, 1),
    scheduledAt: nullableTimestamp(row.scheduledAt),
    status: text(row.status),
    dryRun: row.dryRun === true,
    disclosureDecision: oneOf(row.disclosureDecision, ["DISCLOSE", "NOT_REQUIRED"] as const),
    disclosureText: nullableText(row.disclosureText),
    disclosureReason: text(row.disclosureReason),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    destinations: row.destinations.map(parseDestination),
  };
}

export function parseHistory(value: unknown, workspaceId: string): PublishedRecord[] {
  if (!Array.isArray(value)) invalid();
  return value.map((item) => {
    const row = record(item);
    if (row.workspaceId !== workspaceId) invalid();
    return {
      workspaceId,
      channelId: text(row.channelId),
      scheduledPostId: text(row.scheduledPostId),
      destinationId: text(row.destinationId),
      renderJobId: text(row.renderJobId),
      platform: platform(row.platform),
      platformPostId: text(row.platformPostId),
      publishedAt: timestamp(row.publishedAt),
    };
  });
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
}

export function isEditableRole(role: string): boolean {
  return role === "OWNER" || role === "EDITOR";
}

export function parseAuthorizationUrl(value: unknown): string {
  const row = record(value);
  const raw = text(row.authorizationUrl);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalid("The connection response did not include a valid authorization URL.");
  }
  if (url.protocol !== "https:")
    invalid("The connection response did not include a secure authorization URL.");
  return url.href;
}
