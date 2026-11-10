import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time secret comparison (M19 residual R5). Both values are hashed with SHA-256 first, so
 * the comparison always runs over two 32-byte digests and leaks neither content nor length.
 */
export function secretsEqual(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}
