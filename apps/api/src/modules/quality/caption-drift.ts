import { AlignedWordSchema } from "@reelforge/contracts";
import { z } from "zod";

function timestamp(value: string): number {
  const match = /^(\d+):([0-5]\d):([0-5]\d)\.(\d{2})$/.exec(value);
  if (!match) throw new Error("Invalid caption timestamp");
  return (
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100
  );
}

/** Compares the actual ASS input sent to FFmpeg to the independently persisted forced alignment. */
export function captionDriftMs(alignment: unknown, script: string): number {
  const words = z.array(AlignedWordSchema).min(1).parse(alignment);
  const lines = script.split(/\r?\n/).filter((line) => line.startsWith("Dialogue:"));
  if (lines.length !== words.length) throw new Error("Caption count does not match alignment");
  return Math.max(
    ...words.map((word, index) => {
      const line = lines[index];
      const match = line && /^Dialogue:\s*0,([^,]+),([^,]+),Default,,0,0,0,,(.*)$/.exec(line);
      const expected = word.text
        .replaceAll("\\", "＼")
        .replaceAll("{", "(")
        .replaceAll("}", ")")
        .replace(/[\r\n]/g, " ");
      if (!match || match[3] !== expected) throw new Error("Caption text does not match alignment");
      const start = timestamp(match[1]!);
      const end = timestamp(match[2]!);
      if (end <= start) throw new Error("Invalid caption interval");
      return Math.max(Math.abs(start - word.start), Math.abs(end - word.end)) * 1000;
    }),
  );
}
