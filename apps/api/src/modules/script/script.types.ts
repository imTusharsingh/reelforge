type ScriptScene = Readonly<{
  id: string;
  startSeconds: number;
  durationSeconds: number;
  /** @deprecated Read compatibility only for V5; M07 writes permit only an empty array. Removed with V5/T2 readers. */
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
