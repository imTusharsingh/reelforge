import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { BadRequestException } from "@nestjs/common";

const scrypt = promisify(nodeScrypt);
const SCRYPT_KEY_LENGTH = 64;
export const DUMMY_PASSWORD_HASH = `scrypt:${Buffer.alloc(16).toString("base64url")}:${Buffer.alloc(SCRYPT_KEY_LENGTH).toString("base64url")}`;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12)
    throw new BadRequestException("Password must be at least 12 characters.");
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1] ?? "", "base64url");
  const expected = Buffer.from(parts[2] ?? "", "base64url");
  if (salt.length === 0 || expected.length !== SCRYPT_KEY_LENGTH) return false;
  const actual = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  return timingSafeEqual(actual, expected);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}
