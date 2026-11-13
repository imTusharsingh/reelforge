import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { TokenVault } from "./token-vault.js";

describe("TokenVault", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");

  it("encrypts secrets and binds them to their account context", () => {
    const vault = new TokenVault(key);
    const encrypted = vault.encrypt("fixture-access-token", "workspace-a:account-a:access");

    expect(encrypted.ciphertext).not.toContain("fixture-access-token");
    expect(
      vault.decrypt({ ...encrypted, keyVersion: "env-v1" }, "workspace-a:account-a:access"),
    ).toBe("fixture-access-token");
    expect(() =>
      vault.decrypt({ ...encrypted, keyVersion: "env-v1" }, "workspace-b:account-a:access"),
    ).toThrow();
  });

  it("fails closed when no valid local key is configured", () => {
    expect(() => new TokenVault(undefined).encrypt("secret", "context")).toThrow(
      ServiceUnavailableException,
    );
    expect(() => new TokenVault("short").encrypt("secret", "context")).toThrow(
      ServiceUnavailableException,
    );
  });
});

describe("token vault availability", () => {
  it("reports availability without encrypting or disclosing configuration", () => {
    expect(new TokenVault(undefined).isConfigured()).toBe(false);
    expect(new TokenVault("invalid").isConfigured()).toBe(false);
    expect(new TokenVault(Buffer.alloc(32, 7).toString("base64url")).isConfigured()).toBe(true);
  });
});
