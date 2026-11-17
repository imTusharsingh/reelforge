import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import { AlignedWordSchema, type AlignedWord } from "@reelforge/contracts";
import { z } from "zod";
const alignment = z.object({
  fragments: z.array(
    z.object({ begin: z.string(), end: z.string(), lines: z.array(z.string()).min(1) }),
  ),
});
export interface WordAligner {
  align(
    audio: string,
    text: string,
    language: string,
    root: string,
    duration: number,
  ): Promise<AlignedWord[]>;
}
/** Offline forced alignment, not proportional word timing or a live transcription service.
 * Deployment installs pinned aeneas==1.7.3.0 + its local eSpeak/FFmpeg dependencies. */
@Injectable()
export class LocalWordAligner implements WordAligner {
  public async align(
    audio: string,
    text: string,
    language: string,
    root: string,
    duration: number,
  ): Promise<AlignedWord[]> {
    const words = text.trim().split(/\s+/u).filter(Boolean);
    if (!words.length) throw new Error("Narration transcript required");
    const languages: Record<string, string> = {
      English: "eng",
      en: "eng",
      Hindi: "hin",
      hi: "hin",
      Spanish: "spa",
      es: "spa",
      French: "fra",
      fr: "fra",
      German: "deu",
      de: "deu",
    };
    const code = languages[language] ?? (/^[a-z]{3}$/.test(language) ? language : undefined);
    if (!code) throw new Error("Local alignment language must be configured as ISO 639-3");
    const transcript = join(root, "words.txt"),
      output = join(root, "alignment.json");
    await writeFile(transcript, words.join("\n"));
    await promisify(execFile)(
      process.env.ALIGNMENT_PYTHON_PATH ?? "python3",
      [
        "-m",
        "aeneas.tools.execute_task",
        audio,
        transcript,
        `task_language=${code}|is_text_type=plain|os_task_file_format=json`,
        output,
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    const fragments = alignment.parse(
      JSON.parse(await readFile(output, "utf8")) as unknown,
    ).fragments;
    const result = fragments.map((word) =>
      AlignedWordSchema.parse({
        text: word.lines.join(" "),
        start: Number(word.begin),
        end: Number(word.end),
      }),
    );
    if (
      result.length !== words.length ||
      result.some(
        (word, index) =>
          word.text !== words[index] ||
          word.end > duration + 0.001 ||
          (index > 0 && word.start < result[index - 1]!.end),
      )
    )
      throw new Error("Forced alignment does not match the narration transcript");
    return result;
  }
}
export function wordCaptions(words: readonly AlignedWord[]): string {
  const stamp = (seconds: number): string => {
    const centis = Math.round(seconds * 100);
    return `${Math.floor(centis / 360000)}:${String(Math.floor(centis / 6000) % 60).padStart(2, "0")}:${String(Math.floor(centis / 100) % 60).padStart(2, "0")}.${String(centis % 100).padStart(2, "0")}`;
  };
  const safe = (text: string): string =>
    text
      .replaceAll("\\", "＼")
      .replaceAll("{", "(")
      .replaceAll("}", ")")
      .replace(/[\r\n]/g, " ");
  return (
    `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,DejaVu Sans,64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,2,120,120,240,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n` +
    words
      .map(
        (word) =>
          `Dialogue: 0,${stamp(word.start)},${stamp(word.end)},Default,,0,0,0,,${safe(word.text)}`,
      )
      .join("\n") +
    "\n"
  );
}
