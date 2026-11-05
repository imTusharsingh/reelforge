import { createHash } from "node:crypto";

export function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
