import type { LlmProviderPort, ProviderProvenance } from "@reelforge/ai-providers";

/** @deprecated V4 replaces scene planning with ShotSpec; obsolete columns removed via T2 ADR/migration. */
export type ScriptScene = Readonly<{
  id: string;
  startSeconds: number;
  durationSeconds: number;
  characterRefs: ReadonlyArray<Readonly<{ characterId: string; versionId: string }>>;
  dialogue: string;
  narration?: string;
  visualDescription: string;
  camera: string;
  audioCues: ReadonlyArray<string>;
  transition?: string;
}>;
export type ScriptDocument = Readonly<{
  schemaVersion: "1.0";
  title: string;
  hook: string;
  dialogue: string;
  narration?: string;
  cta: string;
  metadata: Readonly<{ genre: string; targetDurationSeconds: number; factual: boolean }>;
  scenes: ReadonlyArray<ScriptScene>;
  claims?: ReadonlyArray<Readonly<{ text: string; sourceUrl: string }>>;
}>;
export type ScriptGenerationResult = Readonly<{
  document: ScriptDocument;
  provenance: ProviderProvenance;
  approvedIdeaSnapshotId: string;
  approvedIdeaChecksum: string;
}>;
export type ScriptLlmPort = LlmProviderPort<unknown>;
