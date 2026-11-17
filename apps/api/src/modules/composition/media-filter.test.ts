import { describe, expect, it } from "vitest";
import { wordCaptions } from "./media-alignment.js";
import { assemblyArguments } from "./media-filter.js";
describe("V5 media composition plan", () => {
  it("normalizes real video, preserves timeline length with crossfades, ducks music and keeps quiet ambience", () => {
    const args = assemblyArguments(
      [
        { path: "a.mp4", seconds: 5, audio: true, fade: true },
        { path: "b.mp4", seconds: 5, audio: false, fade: false },
      ],
      "voice.wav",
      "music.wav",
      "captions.ass",
      "final.mp4",
      10,
    );
    const filters = args[args.indexOf("-filter_complex") + 1]!;
    for (const expected of [
      "scale=1080:1920",
      "fps=24",
      "volume=-18dB",
      "sidechaincompress",
      "loudnorm=I=-14",
      "xfade=transition=fade:duration=0.25:offset=5",
      "tpad=stop_mode=clone",
      "anullsrc",
      "subtitles=",
    ])
      expect(filters).toContain(expected);
    expect(args).toContain("libx264");
    expect(args).not.toContain("-loop");
  });
  it("renders aligned words within the safe zone and escapes ASS control sequences", () => {
    const ass = wordCaptions([{ text: "Hello{\\n}", start: 0.25, end: 1 }]);
    expect(ass).toContain("0:00:00.25,0:00:01.00");
    expect(ass).toContain("120,120,240");
    expect(ass).not.toContain("{\\n}");
  });
});
