import { ConflictException } from "@nestjs/common";
import { z } from "zod";
import { NarrationLanguageUnavailable } from "./alignment-language.js";
import { mediaRuntimeGate, type MediaReadiness } from "./media-runtime.js";

const snapshotNarration = z.object({
  brief: z.object({ languages: z.object({ narration: z.string() }) }),
});

function unsupported(error: unknown): never {
  if (!(error instanceof NarrationLanguageUnavailable)) throw error;
  throw new ConflictException({ code: "NARRATION_LANGUAGE_UNSUPPORTED", message: error.message });
}

export function assertVideoRunLanguage(language: () => unknown): void {
  try {
    mediaRuntimeGate.assertLanguage(language);
  } catch (error) {
    unsupported(error);
  }
}

function pinnedNarration(snapshot: unknown): string | undefined {
  return snapshotNarration.safeParse(snapshot).data?.brief.languages.narration;
}

export async function preparePinnedVideoRunLanguage(
  snapshot: () => unknown,
): Promise<MediaReadiness | undefined> {
  try {
    return await mediaRuntimeGate.prepareLanguage(async () => pinnedNarration(await snapshot()));
  } catch (error) {
    unsupported(error);
  }
}

export function assertPinnedVideoRunLanguage(
  snapshot: unknown,
  proof: MediaReadiness | undefined,
): void {
  try {
    mediaRuntimeGate.assertFreshLanguage(() => pinnedNarration(snapshot), proof);
  } catch (error) {
    unsupported(error);
  }
}
