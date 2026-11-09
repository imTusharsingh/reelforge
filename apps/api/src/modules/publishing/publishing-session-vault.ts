import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";

export type EncryptedPublishingSession = Readonly<{
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: "env-v1";
}>;

export class PublishingSessionVault {
  private readonly key: Buffer | null;

  public constructor(encodedKey: string | undefined) {
    if (encodedKey === undefined || encodedKey.length === 0) {
      this.key = null;
      return;
    }
    const decoded = Buffer.from(encodedKey, "base64url");
    if (decoded.byteLength !== 32 || decoded.toString("base64url") !== encodedKey)
      throw new Error("PUBLISH_SESSION_ENCRYPTION_KEY must be 32 bytes encoded as base64url");
    this.key = decoded;
  }

  public isConfigured(): boolean {
    return this.key !== null;
  }

  public encrypt(value: string, context: string): EncryptedPublishingSession {
    const key = this.requireKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64url"),
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      keyVersion: "env-v1",
    };
  }

  public decrypt(value: EncryptedPublishingSession, context: string): string {
    if (value.keyVersion !== "env-v1")
      throw new ServiceUnavailableException("Unsupported publishing session key version");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.requireKey(),
      Buffer.from(value.nonce, "base64url"),
    );
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  private requireKey(): Buffer {
    const key = this.key;
    if (key === null)
      throw new ServiceUnavailableException(
        "PUBLISH_SESSION_ENCRYPTION_KEY is required to persist resumable upload sessions",
      );
    return key;
  }
}
