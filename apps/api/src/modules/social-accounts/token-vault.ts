import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";

export type EncryptedSecret = Readonly<{
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: "env-v1";
}>;

export class TokenVault {
  public constructor(private readonly encodedKey: string | undefined) {}

  public encrypt(value: string, context: string): EncryptedSecret {
    const key = this.key();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString(
      "base64url",
    );
    return {
      ciphertext,
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      keyVersion: "env-v1",
    };
  }

  public decrypt(secret: EncryptedSecret, context: string): string {
    if (secret.keyVersion !== "env-v1")
      throw new ServiceUnavailableException("Unsupported social token encryption key version");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key(),
      Buffer.from(secret.nonce, "base64url"),
    );
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(secret.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  private key(): Buffer {
    const encoded = this.encodedKey;
    if (encoded === undefined || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
      throw new ServiceUnavailableException(
        "Social account encryption is not configured; set a 32-byte base64url key.",
      );
    }
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== encoded) {
      throw new ServiceUnavailableException(
        "Social account encryption key must encode exactly 32 bytes.",
      );
    }
    return key;
  }
}
