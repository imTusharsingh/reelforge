import type { ReferenceAsset, ReferencePin } from "@reelforge/contracts";

const order = { CHARACTER: 0, SCENERY: 1, PROP: 2, STYLE: 3 } as const;
export function selectReferences(assets: readonly ReferenceAsset[]): ReferenceAsset[] {
  const unique = new Map(assets.map((asset) => [`${asset.referenceId}@${asset.version}`, asset]));
  const result = [...unique.values()].sort((a, b) => order[a.kind] - order[b.kind]);
  // Reject rather than silently discard required character views or a style lock.
  const imageCount = result.reduce(
    (sum, ref) => sum + (Array.isArray(ref.metadata.images) ? ref.metadata.images.length : 1),
    0,
  );
  if (imageCount > 6) throw new Error("Omni accepts at most six reference images");
  return result;
}
export function referencePins(assets: readonly ReferenceAsset[]): ReferencePin[] {
  return assets.map((asset) => ({ referenceAssetId: asset.referenceId, version: asset.version }));
}
