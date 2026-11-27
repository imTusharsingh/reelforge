import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import { AlignedWordSchema, type AlignedWord } from "@reelforge/contracts";
import { z } from "zod";
import { captionPhrases, readableCaptionCues, type CaptionCue } from "./phrase-captions.js";
import { alignmentPython, mediaExecutable, mediaRuntimeGate } from "./media-runtime.js";
const alignment = z.object({
  fragments: z.array(
    z.object({ begin: z.string(), end: z.string(), lines: z.array(z.string()).min(1) }),
  ),
});
type Align<T = AlignedWord[]> = (
  audio: string,
  text: string,
  language: string,
  root: string,
  duration: number,
) => Promise<T>;
export interface WordAligner {
  alignMeasured: Align<WordAlignment>;
  alignPhrases: Align;
}

export type WordAlignment = {
  words: AlignedWord[];
  // Only unrepaired observations may drive visible highlighting. Missing anchors stay null.
  highlights: (AlignedWord | null)[];
};

/** Offline forced alignment against actual narration and local eSpeak reference speech. */
@Injectable()
export class LocalWordAligner implements WordAligner {
  public async align(
    audio: string,
    text: string,
    language: string,
    root: string,
    duration: number,
  ): Promise<AlignedWord[]> {
    return (await this.alignMeasured(audio, text, language, root, duration)).words;
  }

  public async alignMeasured(
    audio: string,
    text: string,
    language: string,
    root: string,
    duration: number,
  ): Promise<WordAlignment> {
    const words = text.trim().split(/\s+/u).filter(Boolean);
    if (!words.length) throw new Error("Narration transcript required");
    const measured = await measure(audio, words, language, root, "words");
    return {
      words: fitWordIntervals(measured, words, duration),
      highlights: measured.map((word) => (usableAnchor(word) ? word : null)),
    };
  }

  public async alignPhrases(
    audio: string,
    text: string,
    language: string,
    root: string,
    duration: number,
  ): Promise<CaptionCue[]> {
    const phrases = captionPhrases(text);
    const measured = await measure(audio, phrases, language, root, "phrases");
    return readableCaptionCues(measured, phrases, duration);
  }
}

async function measure(
  audio: string,
  fragments: readonly string[],
  language: string,
  root: string,
  kind: "words" | "phrases",
): Promise<AlignedWord[]> {
  const code = mediaRuntimeGate.resolveLanguage(language);
  const transcript = join(root, `${kind}.txt`);
  const output = join(root, `${kind}-alignment.json`);
  await writeFile(transcript, fragments.join("\n"));
  await promisify(execFile)(
    alignmentPython(),
    [
      "-m",
      "aeneas.tools.execute_task",
      audio,
      transcript,
      `task_language=${code}|is_text_type=plain|os_task_file_format=json|task_adjust_boundary_no_zero=${kind === "phrases" ? "True" : "False"}`,
      output,
      // eSpeak's reference WAV uses 22,050 Hz. Analyzing narration at 16 kHz
      // against that different reference rate sent late anchors to the last frame.
      `-r=ffmpeg_sample_rate=22050|mfcc_mask_nonspeech=True|aba_no_zero_duration=0.080|ffmpeg_path=${mediaExecutable("ffmpeg")}|ffprobe_path=${mediaExecutable("ffprobe")}|cew=False`,
    ],
    { timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  return alignment
    .parse(JSON.parse(await readFile(output, "utf8")) as unknown)
    .fragments.map((fragment) => ({
      text: fragment.lines.join(" "),
      start: Number(fragment.begin),
      end: Number(fragment.end),
    }));
}

export const centis = (seconds: number): number => Math.round(seconds * 100);
// ASS is centisecond-based. Five ticks cover at least one frame at 24 fps.
export const minimumCue = 5;
const maximumAdjustment = 80;

function usableAnchor(word: AlignedWord): boolean {
  return centis(word.end) - centis(word.start) >= minimumCue;
}

function fitWordIntervals(
  measured: readonly AlignedWord[],
  words: readonly string[],
  duration: number,
): AlignedWord[] {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    measured.length !== words.length ||
    measured.some(
      (word, index) =>
        word.text !== words[index] ||
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < 0 ||
        word.end < word.start ||
        word.end > duration + 0.001 ||
        (index > 0 && word.start < measured[index - 1]!.end),
    )
  )
    throw new Error("Forced alignment does not match the narration transcript");

  const anchors = measured.filter(usableAnchor);
  if (anchors.length === measured.length)
    return measured.map((word) => AlignedWordSchema.parse(word));
  // Keep well-measured words and pauses unchanged where possible. Repair clustered,
  // short intervals using their neighbors; never spread a largely missing alignment.
  if (anchors.length < Math.ceil(measured.length / 2))
    throw new Error("Forced alignment has too few usable speech anchors");

  const trackEnd = Math.min(centis(measured.at(-1)!.end), Math.floor(duration * 100));
  let cursor = 0;
  return measured.map((word, index) => {
    const rawStart = centis(word.start);
    const rawEnd = centis(word.end);
    const latestEnd = trackEnd - (words.length - index - 1) * minimumCue;
    const start = Math.min(Math.max(cursor, rawStart), latestEnd - minimumCue);
    const end = Math.min(Math.max(start + minimumCue, rawEnd), latestEnd);
    if (
      start < cursor ||
      Math.abs(start - rawStart) > maximumAdjustment ||
      Math.abs(end - rawEnd) > maximumAdjustment
    )
      throw new Error("Forced alignment cannot fit visible captions within the measured speech");
    cursor = end;
    return AlignedWordSchema.parse({ text: word.text, start: start / 100, end: end / 100 });
  });
}
export type AssEvent = Readonly<{ start: number; end: number; assText: string }>;

export const safeCaptionText = (text: string): string =>
  text
    .replaceAll("\\", "＼")
    .replaceAll("{", "(")
    .replaceAll("}", ")")
    .replace(/[\r\n]/g, " ");

export function wordCaptions(words: readonly CaptionCue[]): string {
  return assCaptions(
    words.map(({ start, end, text }) => ({ start, end, assText: safeCaptionText(text) })),
  );
}

export function assCaptions(events: readonly AssEvent[]): string {
  const stamp = (seconds: number): string => {
    const ticks = centis(seconds);
    return `${Math.floor(ticks / 360000)}:${String(Math.floor(ticks / 6000) % 60).padStart(2, "0")}:${String(Math.floor(ticks / 100) % 60).padStart(2, "0")}.${String(ticks % 100).padStart(2, "0")}`;
  };
  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,DejaVu Sans,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,2,120,120,240,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n` +
    events
      .map(
        (word) =>
          `Dialogue: 0,${stamp(word.start)},${stamp(word.end)},Default,,0,0,0,,${word.assText}`,
      )
      .join("\n") +
    "\n"
  );
}
