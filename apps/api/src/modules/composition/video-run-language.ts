import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import { NarrationLanguageUnavailable } from "./alignment-language.js";
import { mediaRuntimeGate } from "./media-runtime.js";

const snapshotNarration = z.object({
  brief: z.object({ languages: z.object({ narration: z.string() }) }),
});

export function assertVideoRunLanguage(language: () => unknown): void {
  try {
    mediaRuntimeGate.assertLanguage(language);
  } catch (error) {
    if (!(error instanceof NarrationLanguageUnavailable)) throw error;
    throw new ConflictException({ code: "NARRATION_LANGUAGE_UNSUPPORTED", message: error.message });
  }
}

export function assertPinnedVideoRunLanguage(snapshot: unknown): void {
  assertVideoRunLanguage(
    () => snapshotNarration.safeParse(snapshot).data?.brief.languages.narration,
  );
}
