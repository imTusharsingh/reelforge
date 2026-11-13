import { isRecord } from "../channels/model";

export const platformValues = ["YOUTUBE", "INSTAGRAM"] as const;
export type Platform = (typeof platformValues)[number];
export const privacyValues = ["private", "unlisted", "public"] as const;
export type Privacy = (typeof privacyValues)[number];
export type Disclosure =
  | { decision: "DISCLOSE"; disclosureText: string; reason: string }
  | { decision: "NOT_REQUIRED"; reason: string };

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
};
export type EligibleRender = {
  renderJobId: string;
  channelId: string;
  projectId: string;
  title: string;
  durationMs: number;
  completedAt: string;
  qualityReviewRunId: string;
  reviewStatus: "APPROVED" | "AUTO_APPROVED";
  reviewedAt: string;
};
export type Destination = {
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
export type PreflightGate = { id: string; passed: boolean; evidence: string[] };
export type Preflight = {
  scheduledPostId: string;
  destinationId: string;
  canPublish: boolean;
  gates: PreflightGate[];
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
export type CreateDestination = {
  platform: Platform;
  socialAccountId: string;
  metadata:
    | {
        platform: "YOUTUBE";
        title: string;
        description: string;
        tags?: string[];
        privacyStatus: Privacy;
        selfDeclaredMadeForKids: boolean;
      }
    | { platform: "INSTAGRAM"; caption: string };
};
export type CreatePostRequest = {
  clientRequestId: string;
  channelId: string;
  renderJobId: string;
  qualityReviewRunId: string;
  scheduledAt: string | null;
  disclosure: Disclosure;
  destinations: CreateDestination[];
};

function invalid(message = "The publishing service returned invalid or mismatched data."): never {
  throw new Error(message);
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid();
  return value;
}
function stringValue(value: unknown): string {
  if (typeof value !== "string") invalid();
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
    };
  });
}

export function parseEligibleRenders(value: unknown): {
  items: EligibleRender[];
  nextCursor: string | null;
} {
  const page = record(value);
  if (!Array.isArray(page.items)) invalid();
  return {
    items: page.items.map((item) => {
      const row = record(item);
      return {
        renderJobId: text(row.renderJobId),
        channelId: text(row.channelId),
        projectId: text(row.projectId),
        title: text(row.title),
        durationMs: integer(row.durationMs, 1),
        completedAt: timestamp(row.completedAt),
        qualityReviewRunId: text(row.qualityReviewRunId),
        reviewStatus: oneOf(row.reviewStatus, ["APPROVED", "AUTO_APPROVED"] as const),
        reviewedAt: timestamp(row.reviewedAt),
      };
    }),
    nextCursor: nullableText(page.nextCursor),
  };
}

export function parseCreatePostRequest(
  value: unknown,
  expectedClientRequestId?: string,
): CreatePostRequest {
  const row = record(value);
  const clientRequestId = text(row.clientRequestId);
  if (expectedClientRequestId !== undefined && clientRequestId !== expectedClientRequestId)
    invalid();
  if (!Array.isArray(row.destinations) || row.destinations.length === 0) invalid();
  const disclosureRow = record(row.disclosure);
  let disclosure: Disclosure;
  if (disclosureRow.decision === "DISCLOSE") {
    disclosure = {
      decision: "DISCLOSE",
      disclosureText: text(disclosureRow.disclosureText),
      reason: text(disclosureRow.reason),
    };
  } else if (disclosureRow.decision === "NOT_REQUIRED") {
    disclosure = { decision: "NOT_REQUIRED", reason: text(disclosureRow.reason) };
  } else {
    invalid();
  }
  return {
    clientRequestId,
    channelId: text(row.channelId),
    renderJobId: text(row.renderJobId),
    qualityReviewRunId: text(row.qualityReviewRunId),
    scheduledAt: nullableTimestamp(row.scheduledAt),
    disclosure,
    destinations: row.destinations.map((item) => {
      const destination = record(item);
      const metadata = record(destination.metadata);
      if (destination.platform === "YOUTUBE") {
        if (metadata.platform !== "YOUTUBE") invalid();
        const title = text(metadata.title);
        if (title.length > 100) invalid();
        const description = stringValue(metadata.description);
        if (description.length > 5000) invalid();
        const tags =
          metadata.tags === undefined
            ? undefined
            : Array.isArray(metadata.tags) && metadata.tags.every((tag) => typeof tag === "string")
              ? (metadata.tags as string[])
              : invalid();
        if (metadata.categoryId !== undefined && typeof metadata.categoryId !== "string") invalid();
        return {
          platform: "YOUTUBE" as const,
          socialAccountId: text(destination.socialAccountId),
          metadata: {
            platform: "YOUTUBE" as const,
            title,
            description,
            ...(tags === undefined ? {} : { tags }),
            ...(metadata.categoryId === undefined ? {} : { categoryId: metadata.categoryId }),
            privacyStatus: oneOf(metadata.privacyStatus, privacyValues),
            selfDeclaredMadeForKids: boolean(metadata.selfDeclaredMadeForKids),
          },
        };
      }
      if (destination.platform === "INSTAGRAM") {
        if (metadata.platform !== "INSTAGRAM") invalid();
        const caption = stringValue(metadata.caption);
        if (caption.length > 2200) invalid();
        return {
          platform: "INSTAGRAM" as const,
          socialAccountId: text(destination.socialAccountId),
          metadata: { platform: "INSTAGRAM" as const, caption },
        };
      }
      return invalid();
    }),
  };
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
    disclosureDecision: oneOf(row.disclosureDecision, ["DISCLOSE", "NOT_REQUIRED"] as const),
    disclosureText: nullableText(row.disclosureText),
    disclosureReason: text(row.disclosureReason),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
    destinations: row.destinations.map(parseDestination),
  };
}

export function parsePosts(value: unknown): Post[] {
  if (!Array.isArray(value)) invalid();
  return value.map((item) => parsePost(item));
}

export function parsePostPage(value: unknown): { items: Post[]; nextCursor: string | null } {
  const page = record(value);
  if (!Array.isArray(page.items)) invalid();
  return {
    items: page.items.map((item) => parsePost(item)),
    nextCursor: nullableText(page.nextCursor),
  };
}

export function parsePreflight(value: unknown, destinationId: string): Preflight {
  const row = record(value);
  if (row.destinationId !== destinationId || !Array.isArray(row.gates)) invalid();
  return {
    scheduledPostId: text(row.scheduledPostId),
    destinationId,
    canPublish: boolean(row.canPublish),
    gates: row.gates.map((item) => {
      const gate = record(item);
      if (
        !Array.isArray(gate.evidence) ||
        !gate.evidence.every((entry) => typeof entry === "string")
      )
        invalid();
      return {
        id: text(gate.id),
        passed: boolean(gate.passed),
        evidence: gate.evidence as string[],
      };
    }),
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

export function describeGates(gates: PreflightGate[]): string[] {
  return gates.map(
    (gate) => `${gate.id}: ${gate.passed ? "passed" : "failed"} — ${gate.evidence.join("; ")}`,
  );
}
