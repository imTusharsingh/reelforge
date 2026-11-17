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
