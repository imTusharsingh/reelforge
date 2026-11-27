import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    options: object,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void => {
    void options;
    void mocked.command(file, args).then(
      () => callback(null, "", ""),
      (error: Error) => callback(error, "", ""),
    );
  },
}));
import { LocalWordAligner } from "./media-alignment.js";
afterEach(() => vi.restoreAllMocks());
describe("local word forced alignment", () => {
  it("aligns the actual audio against one word per transcript line, with no network fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "v5-align-test-"));
    try {
      mocked.command.mockImplementation(async (_file: string, args: string[]): Promise<void> => {
        expect(args[0]).toBe("-m");
        expect(args[1]).toBe("aeneas.tools.execute_task");
        expect(args[4]).toContain("task_adjust_boundary_no_zero=False");
        expect(args[6]).toContain("mfcc_mask_nonspeech=True");
        expect(args[6]).toContain("ffmpeg_sample_rate=22050");
        expect(await readFile(args[3]!, "utf8")).toBe("Hello\nworld");
        await writeFile(
          args[5]!,
          JSON.stringify({
            fragments: [
              { begin: "0.1", end: "0.4", lines: ["Hello"] },
              { begin: "0.5", end: "0.9", lines: ["world"] },
            ],
          }),
        );
      });
      expect(
        await new LocalWordAligner().align("voice.wav", "Hello world", "English", root, 1),
      ).toEqual([
        { text: "Hello", start: 0.1, end: 0.4 },
        { text: "world", start: 0.5, end: 0.9 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("repairs clustered dropped words without changing the remaining measured pause", async () => {
    const root = await mkdtemp(join(tmpdir(), "v5-align-test-"));
    try {
      mocked.command.mockImplementation(async (_file: string, args: string[]): Promise<void> => {
        await writeFile(
          args[5]!,
          JSON.stringify({
            fragments: [
              { begin: "0.10", end: "0.45", lines: ["hello"] },
              { begin: "0.45", end: "0.45", lines: ["tiny"] },
              { begin: "0.45", end: "0.46", lines: ["little"] },
              { begin: "0.46", end: "0.70", lines: ["world"] },
              { begin: "0.90", end: "1.10", lines: ["again"] },
            ],
          }),
        );
      });
      expect(
        await new LocalWordAligner().align(
          "voice.wav",
          "hello tiny little world again",
          "eng",
          root,
          1.2,
        ),
      ).toEqual([
        { text: "hello", start: 0.1, end: 0.45 },
        { text: "tiny", start: 0.45, end: 0.5 },
        { text: "little", start: 0.5, end: 0.55 },
        { text: "world", start: 0.55, end: 0.7 },
        { text: "again", start: 0.9, end: 1.1 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("fails closed when aeneas returns too few measured speech anchors", async () => {
    const root = await mkdtemp(join(tmpdir(), "v5-align-test-"));
    try {
      mocked.command.mockImplementation(async (_file: string, args: string[]): Promise<void> => {
        await writeFile(
          args[5]!,
          JSON.stringify({
            fragments: ["a", "b", "c"].map((word) => ({ begin: "0.4", end: "0.4", lines: [word] })),
          }),
        );
      });
      await expect(
        new LocalWordAligner().align("voice.wav", "a b c", "eng", root, 1.2),
      ).rejects.toThrow("too few usable speech anchors");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not let three zero raw fragments borrow one 800ms anchor to pass admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "v5-align-test-"));
    try {
      mocked.command.mockImplementation(async (_file: string, args: string[]): Promise<void> => {
        expect(args[4]).toContain("task_adjust_boundary_no_zero=False");
        await writeFile(
          args[5]!,
          JSON.stringify({
            fragments: [
              { begin: "0", end: "0", lines: ["one"] },
              { begin: "0", end: "0", lines: ["two"] },
              { begin: "0", end: "0", lines: ["three"] },
              { begin: "0", end: "0.8", lines: ["four"] },
            ],
          }),
        );
      });
      await expect(
        new LocalWordAligner().align("voice.wav", "one two three four", "eng", root, 1),
      ).rejects.toThrow("too few usable speech anchors");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing transcripts, unsupported languages and invalid alignment output", async () => {
    const aligner = new LocalWordAligner();
    await expect(aligner.align("voice.wav", " ", "English", "unused", 1)).rejects.toThrow(
      "transcript",
    );
    await expect(
      aligner.align("voice.wav", "Hello", "unknown-language", "unused", 1),
    ).rejects.toThrow("ISO");
    const root = await mkdtemp(join(tmpdir(), "v5-align-test-"));
    try {
      mocked.command.mockImplementation(async (_file: string, args: string[]): Promise<void> => {
        await writeFile(
          args[5]!,
          JSON.stringify({ fragments: [{ begin: "0", end: "2", lines: ["different"] }] }),
        );
      });
      await expect(aligner.align("voice.wav", "Hello", "eng", root, 1)).rejects.toThrow(
        "does not match",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
