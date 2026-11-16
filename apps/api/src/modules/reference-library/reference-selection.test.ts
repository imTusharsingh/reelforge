import { describe, expect, it } from "vitest";
import type { ReferenceAsset } from "@reelforge/contracts";
import { selectReferences, referencePins } from "./reference-selection.js";
import { UnconfiguredTextPort, UnconfiguredImageGenPort } from "./planning.ports.js";
function reference(kind: ReferenceAsset["kind"], id: string): ReferenceAsset {
  return { kind, referenceId: id, version: 2, metadata: {} } as ReferenceAsset;
}
describe("planning reference selection", () => {
  it("orders characters, scenery, props and style and deduplicates pins", () => {
    const character = reference("CHARACTER", "character");
    const result = selectReferences([
      reference("STYLE", "style"),
      reference("PROP", "prop"),
      reference("SCENERY", "scenery"),
      character,
      character,
    ]);
    expect(result.map((ref) => ref.kind)).toEqual(["CHARACTER", "SCENERY", "PROP", "STYLE"]);
    expect(referencePins(result)[0]).toEqual({ referenceAssetId: "character", version: 2 });
  });
  it("rejects more than six actual images including multi-view refs", () => {
    const multi = reference("CHARACTER", "character");
    multi.metadata.images = ["front", "side", "body"];
    expect(() =>
      selectReferences([
        multi,
        ...Array.from({ length: 4 }, (_, index) => reference("STYLE", String(index))),
      ]),
    ).toThrow("six reference images");
    expect(
      selectReferences(Array.from({ length: 6 }, (_, index) => reference("STYLE", String(index)))),
    ).toHaveLength(6);
  });
  it("fails closed until V2 is bound", () => {
    expect(() => new UnconfiguredTextPort().generate()).toThrow("not configured");
    expect(() => new UnconfiguredImageGenPort().generate()).toThrow("not configured");
  });
});
