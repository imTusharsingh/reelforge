import type { WorkspaceRole } from "../../lib/api";

export type ProductionStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED";
export type OutputKind = "IMAGE" | "VIDEO" | "NARRATION" | "DIALOGUE";
export type OutputStatus = "QUEUED" | "SUCCEEDED" | "REUSED" | "FAILED_RETRYABLE" | "FAILED_FINAL";
export type SceneStatus =
  | "QUEUED"
  | "SUBMITTED"
  | "PROVIDER_PROCESSING"
  | "SUCCEEDED"
  | "RETRY_WAIT"
  | "FAILED_RETRYABLE"
  | "FAILED_FINAL"
  | "CANCELED";
export type RequestedOutputs = {
  image: true;
  video: boolean;
  narration: boolean;
  dialogue: boolean;
};
export type SceneOutput = {
  kind: OutputKind;
  status: OutputStatus;
  assetId: string | null;
  assetVersion: number | null;
  mediaType: string | null;
  byteSize: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};
export type ProductionScene = {
  sceneId: string;
  ordinal: number;
  sceneVersion: number;
  status: SceneStatus;
  outputs: SceneOutput[];
};
export type SceneMediaPackage = {
  schemaVersion: "1.0";
  jobId: string;
  workspaceId: string;
  scriptId: string;
  scriptRevision: number;
  channelId: string | null;
  status: ProductionStatus;
  version: number;
  requestedOutputs: RequestedOutputs;
  scenes: ProductionScene[];
};
export type SceneJobSummary = Omit<SceneMediaPackage, "schemaVersion" | "scenes"> & {
  idempotencyKey: string;
  configSnapshotId: string;
  promptSnapshotId: string;
  createdAt: string;
  updatedAt: string;
};
export type Page<T> = { items: T[]; page: number; pageSize: number; nextPage: number | null };
export type Capability = {
  kind: OutputKind;
  available: boolean;
  reason:
    | "PROVIDER_NOT_CONFIGURED"
    | "CAPABILITY_NOT_REGISTERED"
    | "CAPABILITY_MISMATCH"
    | "PROVIDER_ENVIRONMENT_MISMATCH"
    | "COST_UNKNOWN"
    | null;
  message: string;
  providerId: string | null;
  capabilityId: string | null;
};
export type CapabilityCatalog = {
  workspaceId: string;
  generatedAt: string;
  environment: "development" | "test" | "staging" | "production";
  capabilities: Capability[];
};
export type ScriptScene = {
  id: string;
  startSeconds: number;
  durationSeconds: number;
  dialogue: string;
  narration?: string;
  visualDescription: string;
  camera: string;
  audioCues: string[];
  transition?: string;
};
export type Script = {
  id: string;
  workspaceId: string;
  channelId: string | null;
  status: "DRAFT" | "REVISION_PENDING" | "APPROVED" | "REJECTED";
  currentRevision: number;
  revisions: Array<{
    revision: number;
    document: {
      title: string;
      hook: string;
      dialogue: string;
      narration?: string;
      cta: string;
      metadata: { targetDurationSeconds: number };
      scenes: ScriptScene[];
    };
  }>;
};
export type Asset = {
  id: string;
  workspaceId: string;
  version: number;
  rootAssetId: string;
  mediaType: string;
  filename: string | null;
  byteSize: number | null;
  status: "PENDING" | "PUBLISHED" | "FAILED" | "ARCHIVED";
};
export type RenderArtifact = {
  id: string;
  kind: "VIDEO" | "MANIFEST" | "COVER";
  assetId: string;
  assetVersion: number;
  mediaType: string;
  byteSize: number;
  retainedUntil: string | null;
};
export type RenderJob = {
  id: string;
  workspaceId: string;
  sceneMediaJobId: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "CANCELED";
  attempt: number;
  idempotencyKey: string;
  input: Record<string, unknown>;
  retentionDays: number;
  errorCode: string | null;
  errorMessage: string | null;
  expiredAt: string | null;
  artifacts: RenderArtifact[];
};
export type RenderSummary = {
  jobId: string;
  workspaceId: string;
  sceneMediaJobId: string;
  scriptId: string;
  scriptRevision: number;
  channelId: string | null;
  status: RenderJob["status"];
  attempt: number;
  parentJobId: string | null;
  retentionDays: number;
  errorCode: string | null;
  errorMessage: string | null;
  artifactCount: number;
  createdAt: string;
  updatedAt: string;
  expiredAt: string | null;
};
export type CurrencyTotal = {
  currency: string;
  totalMinor: number;
  actualMinor: number;
  estimatedMinor: number;
  failedEstimatedMinor: number;
  reservedMinor: number;
};
export type Budget = {
  budgetId: string;
  scope: "WORKSPACE" | "CHANNEL";
  channelId: string | null;
  currency: string;
  dailyLimitMinor: number | null;
  monthlyLimitMinor: number | null;
  periods: Array<{
    period: "DAY" | "MONTH";
    limitMinor: number;
    consumedMinor: number;
    remainingMinor: number;
    exhausted: boolean;
  }>;
  unconvertedLedgerRows: number;
};
export type CostBreakdown = {
  workspaceId: string;
  scriptId: string;
  totals: {
    currencies: CurrencyTotal[];
    unknownCostRequests: number;
    unpricedRequests: number;
    notDispatchedRequests: number;
  };
  budgets: Budget[];
};

export const canWrite = (role: WorkspaceRole): boolean => role === "OWNER" || role === "EDITOR";
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const positive = (value: unknown): value is number => integer(value) && Number(value) > 0;
const iso = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const nullableIso = (value: unknown): value is string | null => value === null || iso(value);
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T =>
  typeof value === "string" && values.includes(value as T);
const sameWorkspace = (value: Record<string, unknown>, workspaceId: string): void => {
  if (value.workspaceId !== workspaceId) throw new Error("The service returned another workspace.");
};

const jobStatuses = ["QUEUED", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"] as const;
const kinds = ["IMAGE", "VIDEO", "NARRATION", "DIALOGUE"] as const;
const outputStatuses = [
  "QUEUED",
  "SUCCEEDED",
  "REUSED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
] as const;
const sceneStatuses = [
  "QUEUED",
  "SUBMITTED",
  "PROVIDER_PROCESSING",
  "SUCCEEDED",
  "RETRY_WAIT",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "CANCELED",
] as const;
const renderStatuses = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "CANCELED",
] as const;

function parseOutputs(value: unknown): RequestedOutputs {
  if (
    !record(value) ||
    value.image !== true ||
    typeof value.video !== "boolean" ||
    typeof value.narration !== "boolean" ||
    typeof value.dialogue !== "boolean"
  )
    throw new Error("The service returned invalid requested outputs.");
  return value as RequestedOutputs;
}
function parseOutput(value: unknown): SceneOutput {
  if (
    !record(value) ||
    !oneOf(value.kind, kinds) ||
    !oneOf(value.status, outputStatuses) ||
    !(value.assetId === null || text(value.assetId)) ||
    !(value.assetVersion === null || positive(value.assetVersion)) ||
    !nullableText(value.mediaType) ||
    !(value.byteSize === null || positive(value.byteSize)) ||
    !nullableText(value.errorCode) ||
    !nullableText(value.errorMessage)
  )
    throw new Error("The service returned an invalid scene output.");
  return value as SceneOutput;
}
function parseScene(value: unknown): ProductionScene {
  if (
    !record(value) ||
    !text(value.sceneId) ||
    !integer(value.ordinal) ||
    Number(value.ordinal) < 0 ||
    !positive(value.sceneVersion) ||
    !oneOf(value.status, sceneStatuses) ||
    !Array.isArray(value.outputs)
  )
    throw new Error("The service returned an invalid production scene.");
  return { ...value, outputs: value.outputs.map(parseOutput) } as ProductionScene;
}
export function parsePackage(value: unknown, workspaceId: string): SceneMediaPackage {
  if (!record(value)) throw new Error("The service returned an invalid production job.");
  sameWorkspace(value, workspaceId);
  if (
    value.schemaVersion !== "1.0" ||
    !text(value.jobId) ||
    !text(value.scriptId) ||
    !positive(value.scriptRevision) ||
    !(value.channelId === null || text(value.channelId)) ||
    !oneOf(value.status, jobStatuses) ||
    !positive(value.version) ||
    !Array.isArray(value.scenes)
  )
    throw new Error("The service returned an invalid production job.");
  return {
    ...value,
    requestedOutputs: parseOutputs(value.requestedOutputs),
    scenes: value.scenes.map(parseScene),
  } as SceneMediaPackage;
}
function parseSummary(value: unknown, workspaceId: string): SceneJobSummary {
  if (!record(value)) throw new Error("Invalid production history.");
  sameWorkspace(value, workspaceId);
  if (
    !text(value.jobId) ||
    !text(value.scriptId) ||
    !positive(value.scriptRevision) ||
    !(value.channelId === null || text(value.channelId)) ||
    !oneOf(value.status, jobStatuses) ||
    !positive(value.version) ||
    !text(value.idempotencyKey) ||
    !text(value.configSnapshotId) ||
    !text(value.promptSnapshotId) ||
    !iso(value.createdAt) ||
    !iso(value.updatedAt)
  )
    throw new Error("Invalid production history.");
  return { ...value, requestedOutputs: parseOutputs(value.requestedOutputs) } as SceneJobSummary;
}
function parsePage<T>(value: unknown, item: (v: unknown) => T): Page<T> {
  if (
    !record(value) ||
    !Array.isArray(value.items) ||
    !positive(value.page) ||
    !positive(value.pageSize) ||
    !(value.nextPage === null || positive(value.nextPage))
  )
    throw new Error("Invalid page response.");
  return {
    items: value.items.map(item),
    page: value.page,
    pageSize: value.pageSize,
    nextPage: value.nextPage,
  };
}
export const parseSceneJobs = (value: unknown, workspaceId: string): Page<SceneJobSummary> =>
  parsePage(value, (row) => parseSummary(row, workspaceId));

export function parseCapabilities(value: unknown, workspaceId: string): CapabilityCatalog {
  const reasons = [
    "PROVIDER_NOT_CONFIGURED",
    "CAPABILITY_NOT_REGISTERED",
    "CAPABILITY_MISMATCH",
    "PROVIDER_ENVIRONMENT_MISMATCH",
    "COST_UNKNOWN",
  ] as const;
  if (!record(value)) throw new Error("Invalid capability catalog.");
  sameWorkspace(value, workspaceId);
  if (
    !iso(value.generatedAt) ||
    !oneOf(value.environment, ["development", "test", "staging", "production"] as const) ||
    !Array.isArray(value.capabilities)
  )
    throw new Error("Invalid capability catalog.");
  const capabilities = value.capabilities.map((row): Capability => {
    if (
      !record(row) ||
      !oneOf(row.kind, kinds) ||
      typeof row.available !== "boolean" ||
      !(row.reason === null || oneOf(row.reason, reasons)) ||
      !text(row.message) ||
      !(row.providerId === null || text(row.providerId)) ||
      !(row.capabilityId === null || text(row.capabilityId))
    )
      throw new Error("Invalid capability catalog.");
    if (
      row.available &&
      (row.reason !== null || row.providerId === null || row.capabilityId === null)
    )
      throw new Error("Available capability is missing registration metadata.");
    return row as Capability;
  });
  return { ...value, capabilities } as CapabilityCatalog;
}

export function parseScript(value: unknown, workspaceId: string): Script {
  if (!record(value)) throw new Error("Invalid script.");
  sameWorkspace(value, workspaceId);
  if (
    !text(value.id) ||
    !(value.channelId === null || text(value.channelId)) ||
    !oneOf(value.status, ["DRAFT", "REVISION_PENDING", "APPROVED", "REJECTED"] as const) ||
    !positive(value.currentRevision) ||
    !Array.isArray(value.revisions) ||
    value.revisions.length !== 1
  )
    throw new Error("Invalid script.");
  const revision = value.revisions[0];
  if (
    !record(revision) ||
    revision.revision !== value.currentRevision ||
    !record(revision.document)
  )
    throw new Error("Invalid script revision.");
  const document = revision.document;
  if (
    !text(document.title) ||
    !text(document.hook) ||
    typeof document.dialogue !== "string" ||
    typeof document.cta !== "string" ||
    !record(document.metadata) ||
    typeof document.metadata.targetDurationSeconds !== "number" ||
    !Array.isArray(document.scenes)
  )
    throw new Error("Invalid script document.");
  const scenes = document.scenes.map((scene): ScriptScene => {
    if (
      !record(scene) ||
      !text(scene.id) ||
      typeof scene.startSeconds !== "number" ||
      typeof scene.durationSeconds !== "number" ||
      typeof scene.dialogue !== "string" ||
      !text(scene.visualDescription) ||
      !text(scene.camera) ||
      !Array.isArray(scene.audioCues) ||
      !scene.audioCues.every((cue) => typeof cue === "string")
    )
      throw new Error("Invalid script scene.");
    return scene as unknown as ScriptScene;
  });
  return { ...value, revisions: [{ ...revision, document: { ...document, scenes } }] } as Script;
}

export function parseAsset(value: unknown, workspaceId: string): Asset {
  if (!record(value)) throw new Error("Invalid asset.");
  sameWorkspace(value, workspaceId);
  if (
    !text(value.id) ||
    !positive(value.version) ||
    !text(value.rootAssetId) ||
    !text(value.mediaType) ||
    !(value.filename === null || typeof value.filename === "string") ||
    !(value.byteSize === null || positive(value.byteSize)) ||
    !oneOf(value.status, ["PENDING", "PUBLISHED", "FAILED", "ARCHIVED"] as const)
  )
    throw new Error("Invalid asset.");
  return value as Asset;
}
export const parseAssets = (value: unknown, workspaceId: string): Asset[] => {
  if (!Array.isArray(value)) throw new Error("Invalid asset list.");
  return value.map((row) => parseAsset(row, workspaceId));
};

function parseArtifact(value: unknown): RenderArtifact {
  if (
    !record(value) ||
    !text(value.id) ||
    !oneOf(value.kind, ["VIDEO", "MANIFEST", "COVER"] as const) ||
    !text(value.assetId) ||
    !positive(value.assetVersion) ||
    !text(value.mediaType) ||
    !positive(value.byteSize) ||
    !nullableIso(value.retainedUntil)
  )
    throw new Error("Invalid render artifact.");
  return value as RenderArtifact;
}
export function parseRender(value: unknown, workspaceId: string): RenderJob {
  if (!record(value)) throw new Error("Invalid render job.");
  sameWorkspace(value, workspaceId);
  if (
    !text(value.id) ||
    !text(value.sceneMediaJobId) ||
    !oneOf(value.status, renderStatuses) ||
    !integer(value.attempt) ||
    !text(value.idempotencyKey) ||
    !record(value.input) ||
    !positive(value.retentionDays) ||
    !nullableText(value.errorCode) ||
    !nullableText(value.errorMessage) ||
    !nullableIso(value.expiredAt) ||
    !Array.isArray(value.artifacts)
  )
    throw new Error("Invalid render job.");
  return { ...value, artifacts: value.artifacts.map(parseArtifact) } as RenderJob;
}
function parseRenderSummary(value: unknown, workspaceId: string): RenderSummary {
  if (!record(value)) throw new Error("Invalid render history.");
  sameWorkspace(value, workspaceId);
  if (
    !text(value.jobId) ||
    !text(value.sceneMediaJobId) ||
    !text(value.scriptId) ||
    !positive(value.scriptRevision) ||
    !(value.channelId === null || text(value.channelId)) ||
    !oneOf(value.status, renderStatuses) ||
    !integer(value.attempt) ||
    !(value.parentJobId === null || text(value.parentJobId)) ||
    !positive(value.retentionDays) ||
    !nullableText(value.errorCode) ||
    !nullableText(value.errorMessage) ||
    !integer(value.artifactCount) ||
    !iso(value.createdAt) ||
    !iso(value.updatedAt) ||
    !nullableIso(value.expiredAt)
  )
    throw new Error("Invalid render history.");
  return value as RenderSummary;
}
export const parseRenders = (value: unknown, workspaceId: string): Page<RenderSummary> =>
  parsePage(value, (row) => parseRenderSummary(row, workspaceId));

export function parseCost(value: unknown, workspaceId: string, scriptId: string): CostBreakdown {
  if (
    !record(value) ||
    value.workspaceId !== workspaceId ||
    value.scriptId !== scriptId ||
    !record(value.totals) ||
    !Array.isArray(value.totals.currencies) ||
    !Array.isArray(value.budgets) ||
    !integer(value.totals.unknownCostRequests) ||
    !integer(value.totals.unpricedRequests) ||
    !integer(value.totals.notDispatchedRequests)
  )
    throw new Error("Invalid cost breakdown.");
  const nonnegative = (amount: unknown): amount is number =>
    typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0;
  const currencies = value.totals.currencies.map((item): CurrencyTotal => {
    if (
      !record(item) ||
      !text(item.currency) ||
      !nonnegative(item.totalMinor) ||
      !nonnegative(item.actualMinor) ||
      !nonnegative(item.estimatedMinor) ||
      !nonnegative(item.failedEstimatedMinor) ||
      !nonnegative(item.reservedMinor)
    )
      throw new Error("Invalid currency cost totals.");
    return item as CurrencyTotal;
  });
  const budgets = value.budgets.map((item): Budget => {
    if (
      !record(item) ||
      !text(item.budgetId) ||
      !oneOf(item.scope, ["WORKSPACE", "CHANNEL"] as const) ||
      !(item.channelId === null || text(item.channelId)) ||
      !text(item.currency) ||
      !(item.dailyLimitMinor === null || nonnegative(item.dailyLimitMinor)) ||
      !(item.monthlyLimitMinor === null || nonnegative(item.monthlyLimitMinor)) ||
      !Array.isArray(item.periods)
    )
      throw new Error("Invalid persisted budget.");
    return item as unknown as Budget;
  });
  return {
    workspaceId,
    scriptId,
    totals: {
      currencies,
      unknownCostRequests: value.totals.unknownCostRequests,
      unpricedRequests: value.totals.unpricedRequests,
      notDispatchedRequests: value.totals.notDispatchedRequests,
    },
    budgets,
  };
}

export const statusTone = (
  status: string,
): "neutral" | "success" | "warning" | "danger" | "info" =>
  status === "SUCCEEDED" || status === "REUSED" || status === "APPROVED"
    ? "success"
    : status.includes("FAILED") || status === "FAILED"
      ? "danger"
      : status === "PARTIAL" || status.includes("RETRY")
        ? "warning"
        : status === "RUNNING" || status === "PROVIDER_PROCESSING"
          ? "info"
          : "neutral";
export const mediaPath = (workspaceId: string, asset: { id: string; version: number }): string =>
  `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/assets/${encodeURIComponent(asset.id)}/versions/${asset.version}/content`;
export const artifactPath = (
  workspaceId: string,
  jobId: string,
  artifactId: string,
  download = false,
): string =>
  `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/composition/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}/content${download ? "?download=true" : ""}`;
