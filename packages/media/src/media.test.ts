import { describe, expect, it } from "vitest";
import {
  DEFAULT_RENDER_PROFILE,
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
