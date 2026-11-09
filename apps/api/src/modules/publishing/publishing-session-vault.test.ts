import { describe, expect, it } from "vitest";
import { PublishingSessionVault } from "./publishing-session-vault.js";

const key = Buffer.alloc(32, 4).toString("base64url");

describe("PublishingSessionVault", () => {
  it("encrypts sessions and binds ciphertext to its attempt context", () => {
    const vault = new PublishingSessionVault(key);
    const encrypted = vault.encrypt("https://upload.example/session", "workspace:job:attempt");
    expect(vault.decrypt(encrypted, "workspace:job:attempt")).toBe(
      "https://upload.example/session",
    );
    expect(() => vault.decrypt(encrypted, "workspace:job:other-attempt")).toThrow();
  });

  it("fails closed when no encryption key is configured", () => {
    const vault = new PublishingSessionVault(undefined);
    expect(vault.isConfigured()).toBe(false);
    expect(() => vault.encrypt("https://upload.example/session", "context")).toThrow(
      /PUBLISH_SESSION_ENCRYPTION_KEY/,
    );
  });
});
