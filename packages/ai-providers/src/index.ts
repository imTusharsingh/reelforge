export type IdeaProposal = Readonly<{
  title: string;
  topic: string;
  hook: string;
  angle: string;
  audience: string;
  references: string[];
  expectedFormat: string;
}>;

export type LlmCompletionMetadata = Readonly<{
  modelVersion: string;
  promptVersion: string;
  cost: number | null;
  currency?: string;
}>;

export type IdeaProposalResult = Readonly<{
  proposal: IdeaProposal;
  metadata: LlmCompletionMetadata;
}>;

export interface IdeaProposalLlmPort {
  proposeIdea(
    input: Readonly<{ prompt: string; context?: string; correlationId: string }>,
  ): Promise<IdeaProposalResult>;
}

export const IDEA_PROPOSAL_LLM = Symbol("IDEA_PROPOSAL_LLM");
export type ProviderKind = "llm" | "image" | "video" | "tts";
export type ProviderEnvironment = "development" | "test" | "staging" | "production";
export type CostModel = Readonly<{
  currency: string;
  unit: "request" | "second" | "token" | "megapixel" | "character";
  amount: number | null;
}>;
export type CapabilityMetadata = Readonly<{
  providerId: string;
  capabilityId: string;
  kind: ProviderKind;
  input: ReadonlyArray<string>;
  output: ReadonlyArray<string>;
  supportsReferenceImages: boolean;
  durationSeconds?: Readonly<{ min: number; max: number }>;
  resolution?: Readonly<{ maxWidth: number; maxHeight: number }>;
  asynchronous: boolean;
  polling: boolean;
  regions: ReadonlyArray<string>;
  costModel: CostModel;
}>;
export type ProviderUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  seconds?: number;
  characters?: number;
}>;
export type ProviderProvenance = Readonly<{
  modelVersion: string;
  promptVersion: string;
  cost: number | null;
  currency?: string;
  usage?: ProviderUsage;
}>;
export type LlmRequest = Readonly<{
  prompt: string;
  systemPrompt?: string;
  model?: string;
  correlationId: string;
}>;
export type LlmResponse<T = unknown> = Readonly<{
  output: T;
  metadata: ProviderProvenance;
  providerRequestId?: string;
}>;
export interface LlmProviderPort<T = unknown> {
  readonly capability: CapabilityMetadata;
  complete(request: LlmRequest): Promise<LlmResponse<T>>;
}
export const QUALITY_REVIEW_PORT = Symbol("QUALITY_REVIEW_PORT");
export type QualityReviewCriterion =
  "FACTUALITY" | "CLARITY" | "COHERENCE" | "ENGAGEMENT" | "GENRE_FIT";
export type QualityReviewCriterionResult = Readonly<{
  score: number;
  evidence: ReadonlyArray<string>;
  limitations: ReadonlyArray<string>;
}>;
export type QualityReviewResult = Readonly<{
  criteria: Readonly<Record<QualityReviewCriterion, QualityReviewCriterionResult>>;
  metadata: ProviderProvenance;
}>;
export type QualityReviewRequest = Readonly<{
  correlationId: string;
  title: string;
  hook: string;
  dialogue: string;
  narration: string;
  callToAction: string;
  genre: string;
  allowedTopics: ReadonlyArray<string>;
  blockedTopics: ReadonlyArray<string>;
  claims: ReadonlyArray<Readonly<{ text: string; sourceUrl: string }>>;
  scenes: ReadonlyArray<
    Readonly<{
      id: string;
      dialogue: string;
      narration: string;
      visualDescription: string;
      captions: ReadonlyArray<string>;
    }>
  >;
  requiredDisclosures: ReadonlyArray<string>;
}>;
export interface QualityReviewPort {
  review(request: QualityReviewRequest): Promise<QualityReviewResult>;
}
export type ImageRequest = Readonly<{
  prompt: string;
  referenceImageIds?: ReadonlyArray<string>;
  correlationId: string;
}>;
export type ImageResponse = Readonly<{
  mediaId: string;
  metadata: ProviderProvenance;
  providerRequestId?: string;
}>;
export type ProviderMediaPayload = Readonly<{
  declaredMediaType: string;
  body: Uint8Array;
}>;
export type MediaGenerationResponse = ImageResponse &
  Readonly<{
    providerJobId?: string;
    media: ProviderMediaPayload;
  }>;
export interface ImageProviderPort {
  readonly capability: CapabilityMetadata;
  generate(request: ImageRequest): Promise<MediaGenerationResponse>;
}
export type VideoRequest = Readonly<{
  prompt: string;
  durationSeconds: number;
  correlationId: string;
  providerJobId?: string;
  /** Reuses the first submit's idempotency key when that submit's result is uncertain. */
  idempotencyKey?: string;
  /** Called once the provider has accepted a job and before polling starts. */
  onProviderJobAccepted?: (providerJobId: string) => Promise<void>;
}>;
export interface VideoProviderPort {
  readonly capability: CapabilityMetadata;
  generate(request: VideoRequest): Promise<MediaGenerationResponse>;
}
export type TtsRequest = Readonly<{
  text: string;
  voice: string;
  correlationId: string;
}>;
export interface TtsProviderPort {
  readonly capability: CapabilityMetadata;
  synthesize(request: TtsRequest): Promise<MediaGenerationResponse>;
}
export type ProviderErrorCode =
  | "NOT_CONFIGURED"
  | "CAPABILITY_NOT_REGISTERED"
  | "INVALID_REQUEST"
  | "BUDGET_EXCEEDED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REJECTED"
  | "UNKNOWN";
export type ProviderErrorDetails = Readonly<{
  /** False only when this process provably did not send the provider request. */
  providerCalled?: boolean;
  providerJobId?: string;
}>;

export class ProviderError extends Error {
  public readonly providerCalled: boolean;
  public readonly providerJobId: string | undefined;

  public constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly correlationId: string,
    details: ProviderErrorDetails = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.providerCalled = details.providerCalled !== false;
    this.providerJobId = details.providerJobId;
  }
}
export type ProviderCredential = Readonly<{
  providerId: string;
  environment: ProviderEnvironment;
  secret: string;
}>;
export type ProviderRegistration = Readonly<{
  capability: CapabilityMetadata;
  credential: ProviderCredential;
  healthCheck?: () => Promise<Readonly<{ healthy: boolean; latencyMs: number }>>;
}>;
export class ProviderRegistry {
  private readonly registrations = new Map<string, ProviderRegistration>();
  public register(registration: ProviderRegistration): void {
    if (!registration.credential.secret.trim())
      throw new ProviderError("NOT_CONFIGURED", "Provider credential is empty", "registry");
    this.registrations.set(
      `${registration.capability.providerId}:${registration.capability.capabilityId}`,
      registration,
    );
  }
  public get(providerId: string, capabilityId: string): ProviderRegistration {
    const result = this.registrations.get(`${providerId}:${capabilityId}`);
    if (!result)
      throw new ProviderError(
        "CAPABILITY_NOT_REGISTERED",
        "Provider capability is not registered",
        "registry",
      );
    return result;
  }
  public list(): ReadonlyArray<
    Omit<ProviderRegistration, "credential"> & { credential: Omit<ProviderCredential, "secret"> }
  > {
    return [...this.registrations.values()].map((registration) => ({
      ...registration,
      credential: {
        providerId: registration.credential.providerId,
        environment: registration.credential.environment,
      },
    }));
  }
  public assertReady(
    capability: CapabilityMetadata,
    environment: ProviderEnvironment,
  ): ProviderRegistration {
    const registration = this.get(capability.providerId, capability.capabilityId);
    if (registration.credential.environment !== environment)
      throw new ProviderError(
        "NOT_CONFIGURED",
        "Provider credential is not configured for this environment",
        "registry",
      );
    return registration;
  }
  public async healthCheck(
    providerId: string,
    capabilityId: string,
  ): Promise<Readonly<{ healthy: boolean; latencyMs: number }>> {
    const registration = this.get(providerId, capabilityId);
    if (registration.healthCheck === undefined)
      throw new ProviderError(
        "NOT_CONFIGURED",
        "Provider health check is not configured",
        "health",
      );
    return registration.healthCheck();
  }
}
export type UsageLedgerEntry = Readonly<{
  providerId: string;
  capabilityId: string;
  correlationId: string;
  requestedAt: Date;
  completedAt: Date;
  latencyMs: number;
  usage: ProviderUsage | null;
  estimatedCost: number | null;
  actualCost: number | null;
  currency: string | null;
  responseMetadata: Readonly<Record<string, string | number | boolean | null>>;
}>;
export interface UsageLedger {
  record(entry: UsageLedgerEntry): Promise<void>;
}
export type Budget = Readonly<{
  workspaceId: string;
  channelId?: string;
  dailyLimit: number;
  currency: string;
}>;
export class SpendGuard {
  public constructor(
    private readonly spentToday: (workspaceId: string, channelId?: string) => Promise<number>,
  ) {}
  public async preflight(budget: Budget, estimate: number): Promise<void> {
    if (!Number.isFinite(estimate) || estimate < 0)
      throw new ProviderError("INVALID_REQUEST", "Invalid cost estimate", "budget");
    if (
      (await this.spentToday(budget.workspaceId, budget.channelId)) + estimate >
      budget.dailyLimit
    )
      throw new ProviderError("BUDGET_EXCEEDED", "Daily spend limit would be exceeded", "budget");
  }
}
export const SCRIPT_LLM = Symbol("SCRIPT_LLM");
export const PROVIDER_REGISTRY = Symbol("PROVIDER_REGISTRY");
export const IMAGE_PROVIDER = Symbol("IMAGE_PROVIDER");
export const VIDEO_PROVIDER = Symbol("VIDEO_PROVIDER");
export const TTS_PROVIDER = Symbol("TTS_PROVIDER");
