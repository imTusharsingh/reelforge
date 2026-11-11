export const assetTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "audio/mpeg",
  "audio/wav",
  "video/mp4",
];
export function validateAsset(
  file: { name: string; size: number; type: string },
  holder: string,
  license: string,
  attested: boolean,
): void {
  if (!assetTypes.includes(file.type))
    throw new Error("Choose a supported PNG, JPEG, WebP, MP3, WAV or MP4 file.");
  if (!file.size || file.size > 25 * 1024 * 1024)
    throw new Error(
      "Choose a non-empty file of at most 25 MB. The server may enforce a smaller limit.",
    );
  if (!holder.trim() || !license.trim() || !attested)
    throw new Error("Provide the rights holder, license and rights attestation.");
  if (/[\\/]/.test(file.name) || file.name.includes("..") || file.name.length > 200)
    throw new Error(
      "Choose a filename without path separators, traversal or more than 200 characters.",
    );
}
