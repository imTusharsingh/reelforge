import { describe, expect, it } from "vitest";
import {
  ChangePasswordRequestSchema,
  ChangePasswordResponseSchema,
  UpdateAuthMeRequestSchema,
} from "./identity.js";

describe("identity account contracts", () => {
  it("rejects unknown profile keys, including email", () => {
    expect(UpdateAuthMeRequestSchema.safeParse({ displayName: "A" }).success).toBe(true);
    expect(
      UpdateAuthMeRequestSchema.safeParse({ displayName: "A", email: "x@example.com" }).success,
    ).toBe(false);
    expect(UpdateAuthMeRequestSchema.safeParse({ email: "x@example.com" }).success).toBe(false);
  });

  it("rejects unknown password-change keys", () => {
    expect(
      ChangePasswordRequestSchema.safeParse({
        currentPassword: "current-password-123",
        newPassword: "new-password-12345",
      }).success,
    ).toBe(true);
    expect(
      ChangePasswordRequestSchema.safeParse({
        currentPassword: "current-password-123",
        newPassword: "new-password-12345",
        email: "x@example.com",
      }).success,
    ).toBe(false);
    expect(
      ChangePasswordRequestSchema.safeParse({
        currentPassword: "x".repeat(1025),
        newPassword: "new-password-12345",
      }).success,
    ).toBe(false);
  });

  it("validates password-change responses", () => {
    expect(ChangePasswordResponseSchema.safeParse({ ok: true, revokedSessions: 0 }).success).toBe(
      true,
    );
    expect(ChangePasswordResponseSchema.safeParse({ ok: true, revokedSessions: -1 }).success).toBe(
      false,
    );
  });
});
