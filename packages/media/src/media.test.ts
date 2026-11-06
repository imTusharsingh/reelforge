import { describe, expect, it } from "vitest";
import {
  DEFAULT_RENDER_PROFILE,
  validateSourceImageDimensions,
  buildCompositionArguments,
  canonicalRenderFingerprint,
  subtitleDocument,
  validateMediaInspection,
} from "./index.js";

const valid = {
  streams: [
    { type: "video", codec: "h264", width: 1080, height: 1920, fps: 30, durationSeconds: 2 },
    { type: "audio", codec: "aac", sampleRate: 48000, channels: 2, durationSeconds: 2 },
  ],
} as const;

describe("B3/B5 media policy regressions", () => {
  it("preserves a scene's source audio when separate narration is absent", () => {
    const argv = buildCompositionArguments(
      {
        scenes: [{ path: "/tmp/scene.mp4", durationMs: 1000, image: false, sourceAudio: true }],
        mixAudioPaths: [],
        subtitlePath: "/tmp/captions.ass",
        outputPath: "/tmp/result.mp4",
      },
      DEFAULT_RENDER_PROFILE,
    ) as string[];
    const filters = argv[argv.indexOf("-filter_complex") + 1]!;
    expect(filters).toMatch(/\[0:a\][^;]*\[a0\]/);
    expect(filters).not.toContain("anullsrc");
  });

  it("enforces PNG source dimensions and compatible aspect ratio", () => {
    const invalid: [number, number][] = [
      [1, 1],
      [1079, 1920],
      [1080, 1919],
      [1920, 1080],
    ];
    const valid: [number, number][] = [
      [1080, 1920],
      [2160, 3840],
    ];
    for (const [width, height] of invalid) {
      expect(() =>
        validateSourceImageDimensions(
          { type: "video", codec: "png", width, height },
          DEFAULT_RENDER_PROFILE,
        ),
      ).toThrow(/PNG/);
    }
    for (const [width, height] of valid) {
      expect(() =>
        validateSourceImageDimensions(
          { type: "video", codec: "png", width, height },
          DEFAULT_RENDER_PROFILE,
        ),
      ).not.toThrow();
    }
  });

  it("uses narration explicitly when provided, instead of doubling source audio", () => {
    const argv = buildCompositionArguments(
      {
        scenes: [
          {
            path: "/tmp/scene.mp4",
            narrationPath: "/tmp/narration.wav",
            durationMs: 1000,
            image: false,
            sourceAudio: true,
          },
        ],
        mixAudioPaths: [],
        subtitlePath: "/tmp/captions.ass",
        outputPath: "/tmp/result.mp4",
      },
      DEFAULT_RENDER_PROFILE,
    ) as string[];
    const filters = argv[argv.indexOf("-filter_complex") + 1]!;
    expect(filters).toMatch(/\[1:a\][^;]*\[a0\]/);
  });
});

describe("M10 media composition", () => {
  it("rejects missing audio, bad dimensions, codecs, fps, and short durations", () => {
    expect(() =>
      validateMediaInspection({ streams: [valid.streams[0]] }, DEFAULT_RENDER_PROFILE, 2, true),
    ).toThrow(/audio/i);
    expect(() =>
      validateMediaInspection(
        { streams: [{ ...valid.streams[0], durationSeconds: 0.5, width: 720 }] },
        DEFAULT_RENDER_PROFILE,
        1,
        false,
      ),
    ).toThrow(/dimensions/i);
    expect(() =>
      validateMediaInspection(
        { streams: [{ ...valid.streams[0], durationSeconds: 0.5, codec: "av1" }] },
        DEFAULT_RENDER_PROFILE,
        1,
        false,
      ),
    ).toThrow(/codec/i);
    expect(() =>
      validateMediaInspection(
        { streams: [{ ...valid.streams[0], fps: 25 }] },
        DEFAULT_RENDER_PROFILE,
        1,
        false,
      ),
    ).toThrow(/frame rate/i);
    expect(() =>
      validateMediaInspection(
        { streams: [{ ...valid.streams[0], durationSeconds: 0.5 }] },
        DEFAULT_RENDER_PROFILE,
        1,
        false,
      ),
    ).toThrow(/duration/i);
    expect(validateMediaInspection(valid, DEFAULT_RENDER_PROFILE, 2, true)).toEqual(valid);
  });

  it("uses an independent generator per still image", () => {
    const argv = buildCompositionArguments(
      {
        scenes: [1000, 2000].map((durationMs, index) => ({
          path: `/tmp/scene-${index}.png`,
          durationMs,
          image: true,
        })),
        mixAudioPaths: [],
        subtitlePath: "/tmp/captions.ass",
        outputPath: "/tmp/output.mp4",
      },
      DEFAULT_RENDER_PROFILE,
    );
    const filters = argv[argv.indexOf("-filter_complex") + 1];
    expect(filters).toContain("[0:v]scale=");
    expect(filters).toContain("[1:v]scale=");
    expect(filters).toContain("[v0][v1]concat=n=2:v=1:a=0[video]");
    expect(argv.filter((arg) => arg === "-loop")).toHaveLength(2);
    expect(filters).toContain("setpts=PTS-STARTPTS");
  });

  it("builds deterministic arguments without a shell or interpolated shell syntax", () => {
    const input = {
      scenes: [
        { path: "a; touch PWNED.mp4", durationMs: 2000, narrationPath: undefined, image: true },
      ],
      mixAudioPaths: [],
      subtitlePath: "captions.ass",
      outputPath: "output.mp4",
    };
    const first = buildCompositionArguments(input, DEFAULT_RENDER_PROFILE);
    const second = buildCompositionArguments(input, DEFAULT_RENDER_PROFILE);
    expect(first).toEqual(second);
    expect(first[0]).toBe("-hide_banner");
    expect(first).toContain("a; touch PWNED.mp4");
    expect(first).not.toContain("sh");
    const subtitles = subtitleDocument([], DEFAULT_RENDER_PROFILE);
    expect(subtitles).toContain("2,120,120,120,1");
    expect(first.join(" ")).toContain("libx264");
  });

  it("maps video-only scenes to the correct input index", () => {
    const argv = buildCompositionArguments(
      {
        scenes: [
          { path: "/tmp/first.mp4", durationMs: 1000, image: false },
          { path: "/tmp/second.png", durationMs: 2000, image: true },
        ],
        mixAudioPaths: [],
        subtitlePath: "/tmp/captions.ass",
        outputPath: "/tmp/output.mp4",
      },
      DEFAULT_RENDER_PROFILE,
    );
    const filters = argv[argv.indexOf("-filter_complex") + 1];
    expect(filters).toContain("[0:v]scale=1080:1920");
    expect(filters).toContain("[1:v]scale=1080:1920");
    expect(filters).not.toContain("[2:v]");
  });

  it("rejects an output that does not match the requested duration", () => {
    expect(() => validateMediaInspection(valid, DEFAULT_RENDER_PROFILE, 2.1, true)).toThrow(
      /duration/i,
    );
    expect(() => validateMediaInspection(valid, DEFAULT_RENDER_PROFILE, 1.9, true)).toThrow(
      /duration/i,
    );
  });

  it("offsets narration by each scene start for three-scene fades", () => {
    const profile = {
      ...DEFAULT_RENDER_PROFILE,
      transition: "FADE" as const,
      transitionDurationMs: 400,
    };
    const argv = buildCompositionArguments(
      {
        scenes: [1000, 2000, 1500].map((durationMs, index) => ({
          path: `/tmp/scene-${index}.png`,
          durationMs,
          narrationPath: `/tmp/narration-${index}.m4a`,
          image: true,
        })),
        mixAudioPaths: [],
        subtitlePath: "/tmp/captions.ass",
        outputPath: "/tmp/output.mp4",
      },
      profile,
    );
    const filters = argv[argv.indexOf("-filter_complex") + 1];
    expect(filters).toContain("[a0]adelay=0|0[d0]");
    expect(filters).toContain("[a1]adelay=600|600[d1]");
    expect(filters).toContain("[a2]adelay=2200|2200[d2]");
  });

  it("fingerprints canonical content independently of object key insertion order", () => {
    expect(canonicalRenderFingerprint({ a: 1, b: 2 })).toBe(
      canonicalRenderFingerprint({ b: 2, a: 1 }),
    );
    expect(canonicalRenderFingerprint({ a: 1 })).not.toBe(canonicalRenderFingerprint({ a: 2 }));
  });
});

describe("M10 subtitle timing", () => {
  it("keeps captions within scene bounds and applies the safe margins", async () => {
    const { subtitleDocument } = await import("./index.js");
    const doc = subtitleDocument(
      [{ durationMs: 2000, captions: [{ text: "Hello\nworld", startMs: 100, endMs: 1500 }] }],
      DEFAULT_RENDER_PROFILE,
    );
    expect(doc).toContain("0:00:00.10,0:00:01.50");
    expect(doc).toContain("MarginV");
    expect(doc).toContain("2,120,120,120,1");
    expect(doc).toContain("Hello\\Nworld");
    expect(() =>
      subtitleDocument(
        [{ durationMs: 1000, captions: [{ text: "bad", startMs: 0, endMs: 1001 }] }],
        DEFAULT_RENDER_PROFILE,
      ),
    ).toThrow(/inside/i);
  });
});

describe("M10 fade timeline", () => {
  it("lays second-scene captions and speech over the transition overlap", () => {
    const scenes = [
      { durationMs: 1000, captions: [] },
      {
        durationMs: 2000,
        captions: [{ text: "Second scene", startMs: 0, endMs: 1000 }],
      },
    ];
    const profile = {
      ...DEFAULT_RENDER_PROFILE,
      transition: "FADE" as const,
      transitionDurationMs: 400,
    };
    const subtitles = subtitleDocument(scenes, profile);
    expect(subtitles).toContain("0:00:00.60,0:00:01.60");
    const argv = buildCompositionArguments(
      {
        scenes: scenes.map((scene, index) => ({
          path: `/tmp/scene-${index}.png`,
          durationMs: scene.durationMs,
          narrationPath: `/tmp/narration-${index}.m4a`,
          image: true,
        })),
        mixAudioPaths: [],
        subtitlePath: "/tmp/captions.ass",
        outputPath: "/tmp/output.mp4",
      },
      profile,
    );
    expect(argv[argv.indexOf("-filter_complex") + 1]).toContain("adelay=600|600");
  });
});
