import { PackagingSchema, type Packaging } from "@reelforge/contracts";

export function packageShort(
  input: Readonly<{
    title: string;
    description: string;
    tags: ReadonlyArray<string>;
    coverFrameTimestampMs: number;
  }>,
): Packaging {
  return PackagingSchema.parse({
    title: input.title.trim().slice(0, 100),
    description: input.description.trim().slice(0, 5000),
    tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 30),
    coverFrameTimestampMs: input.coverFrameTimestampMs,
    containsSyntheticMedia: true,
  });
}
