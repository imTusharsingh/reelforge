import { describe, expect, it } from "vitest";
import { AlignedWordSchema, MediaReceiptSchema, AssemblyManifestSchema } from "./media-assembly.js";
describe("additive V5 media contracts", () => {
  it("rejects inverted/empty word intervals and secret or provider URL fields", () => {
    expect(AlignedWordSchema.safeParse({ text: "word", start: 2, end: 1 }).success).toBe(false);
    expect(AlignedWordSchema.safeParse({ text: "word", start: 0, end: 0.2 }).success).toBe(true);
    const receipt = {
      key: "shot-0",
      providerId: "gemini",
      providerJobId: "job",
      modelId: "configured-model",
      promptVersion: "v2",
      seconds: 5,
      costMinor: 35,
      objectKey: `runs/permanent/${"a".repeat(64)}`,
      checksumSha256: "a".repeat(64),
      mimeType: "video/mp4",
    };
    expect(MediaReceiptSchema.parse(receipt).costBasis).toBe("RESERVATION");
    expect(MediaReceiptSchema.safeParse({ ...receipt, providerJobId: null }).success).toBe(false);
    const local = { ...receipt, providerJobId: null, dispatchKey: "local-attempt" };
    expect(MediaReceiptSchema.safeParse(local).success).toBe(false);
    expect(MediaReceiptSchema.safeParse({ ...local, key: "media:text:director" }).success).toBe(
      false,
    );
    expect(
      MediaReceiptSchema.parse({
        ...local,
        key: "media:text:director",
        mimeType: "application/json",
      }),
    ).toMatchObject({ providerJobId: null, dispatchKey: "local-attempt" });
    expect(MediaReceiptSchema.safeParse({ ...receipt, apiKey: "never" }).success).toBe(false);
    expect(AssemblyManifestSchema.safeParse({ totalCostMinor: 801 }).success).toBe(false);
  });
});
