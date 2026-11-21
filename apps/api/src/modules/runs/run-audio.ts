import type { Scoped, Step } from "./runs.types.js";

export const AUDIO_KEYS = ["media:narration", "media:music"];

export function acceptedAudio(runId: string): {
  runId: string;
  key: { in: string[] };
  state: "WAITING_EXTERNAL";
  providerJobId: { not: null };
} {
  return {
    runId,
    key: { in: AUDIO_KEYS },
    state: "WAITING_EXTERNAL",
    providerJobId: { not: null },
  };
}

export function failedAudio(db: Scoped, runId: string): Promise<Step | null> {
  return db.videoRunStep.findFirst({
    where: { runId, key: { in: AUDIO_KEYS }, state: "FAILED" },
    orderBy: { key: "asc" },
  });
}
