import { PackagingSchema, type Packaging } from "@reelforge/contracts";

function limitText(input: string, limit: number, size: (character: string) => number): string {
  let result = "";
  let remaining = limit;
  for (const character of input.replace(/[<>]/g, "").toWellFormed().trim()) {
    remaining -= size(character);
    if (remaining < 0) break;
    result += character;
  }
  return result.trimEnd();
}

export function packageShort(
  input: Readonly<{
    title: string;
    description: string;
    tags: ReadonlyArray<string>;
    coverFrameTimestampMs: number;
  }>,
): Packaging {
  const tags: string[] = [];
  let tagCharacters = 0;
  for (const raw of input.tags) {
    const tag = limitText(raw, 100, (character) => character.length);
    if (!tag || tags.includes(tag)) continue;
    const length = tag.length + (tag.includes(" ") ? 2 : 0) + (tags.length ? 1 : 0);
    if (tagCharacters + length > 500 || tags.length === 30) break;
    tags.push(tag);
    tagCharacters += length;
  }
  return PackagingSchema.parse({
    title: limitText(input.title, 100, (character) => character.length),
    description: limitText(input.description, 5000, (character) => Buffer.byteLength(character)),
    tags,
    coverFrameTimestampMs: input.coverFrameTimestampMs,
    containsSyntheticMedia: true,
  });
}
