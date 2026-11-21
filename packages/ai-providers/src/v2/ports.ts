import type { ProviderCapability, ShotSpec } from "@reelforge/contracts";
export type Money = Readonly<{ currency: "USD"; microUsd: number }>;
export type JobStatus = "queued" | "running" | "succeeded" | "refused" | "failed";
export type MediaInput = Readonly<{
  type: "image" | "video" | "audio";
  mime_type: string;
  data?: string;
  uri?: string;
}>;
export type ClipArtifact = Readonly<{
  objectKey: string;
  checksumSha256: string;
  byteSize: number;
  mimeType: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  billedSeconds: number | null;
}>;
export interface ArtifactStore {
  save(
    body: Uint8Array,
    mimeType: string,
    trimSeconds?: number,
  ): Promise<Omit<ClipArtifact, "billedSeconds">>;
}
export interface ReferenceResolver {
  resolve(spec: ShotSpec): Promise<readonly MediaInput[]>;
}
export type VideoOptions = Readonly<{
  firstFrame?: MediaInput;
  lastFrame?: MediaInput;
  extension?: Readonly<{ providerJobId: string; previousSeconds: number }>;
}>;
export type RecordBilledSeconds = (seconds: number) => Promise<void>;
export interface VideoGenPort {
  capabilities(): ProviderCapability;
  estimate(spec: ShotSpec): Money;
  submit(
    spec: ShotSpec,
    idemKey: string,
    options?: VideoOptions,
  ): Promise<{ providerJobId: string }>;
  poll(providerJobId: string, recordBilling?: RecordBilledSeconds): Promise<JobStatus>;
  fetch(providerJobId: string, recordBilling?: RecordBilledSeconds): Promise<ClipArtifact>;
}
export type ImageSpec = Readonly<{ prompt: string; references?: readonly MediaInput[] }>;
export type TtsSpec = Readonly<{ text: string; voice: string }>;
export type MusicSpec = Readonly<{
  prompt: string;
  durationSeconds: number;
  instrumentalOnly: true;
}>;
export interface MediaJobPort<T> {
  submit(spec: T, idemKey: string): Promise<{ providerJobId: string }>;
  poll(providerJobId: string): Promise<JobStatus>;
  fetch(providerJobId: string, trimSeconds?: number): Promise<ClipArtifact>;
}
export type ImageGenPort = MediaJobPort<ImageSpec>;
export type TtsPort = MediaJobPort<TtsSpec>;
export type MusicPort = MediaJobPort<MusicSpec>;
export type TextSpec<T> = Readonly<{
  prompt: string;
  systemPrompt?: string;
  media?: readonly MediaInput[];
  grounding?: boolean;
  jsonSchema: Record<string, unknown>;
  parse: (value: unknown) => T;
}>;
export interface TextPort {
  complete<T>(
    spec: TextSpec<T>,
    idemKey: string,
  ): Promise<Readonly<{ output: T; providerJobId: string; usage: Record<string, unknown> }>>;
}
