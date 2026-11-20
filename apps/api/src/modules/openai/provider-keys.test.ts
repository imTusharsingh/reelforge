import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database, WorkspaceContext } from "../identity/identity.types.js";
import { TokenVault } from "../social-accounts/token-vault.js";
import { ProviderKeys, parseVendor } from "./provider-keys.js";
import { ProvidersController } from "./providers.controller.js";
import type { WorkspaceService } from "../workspace/workspace.service.js";
import type { AuthenticatedRequest } from "../identity/auth.guard.js";
const key = "AIza" + "aB1".repeat(12);
const context: WorkspaceContext = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  userId: "owner",
  role: "OWNER",
};
function setup(): {
  keys: ProviderKeys;
  delegate: {
    upsert: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
} {
  const delegate = {
    upsert: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  return {
    keys: new ProviderKeys(
      { providerKey: delegate } as unknown as Database,
      new TokenVault(randomBytes(32).toString("base64url")),
    ),
    delegate,
  };
}
afterEach(() => vi.unstubAllEnvs());
describe("write-only provider credentials", () => {
  it("encrypts at rest, never echoes keys and binds AAD to workspace/provider", async () => {
    const { keys, delegate } = setup();
    const logger = vi.spyOn(console, "log");
    const result = await keys.write(context, "gemini", { key: key });
    expect(result).toEqual({ configured: true });
    expect(JSON.stringify(delegate.upsert.mock.calls)).not.toContain(key);
    const encrypted = delegate.upsert.mock.calls[0]![0].create;
    delegate.findUnique.mockResolvedValue(encrypted);
    vi.stubEnv("NODE_ENV", "production");
    expect(await keys.resolve(context, "gemini")).toBe(key);
    await expect(keys.resolve({ ...context, workspaceId: "other" }, "gemini")).rejects.toThrow();
    await expect(keys.resolve(context, "xai")).rejects.toThrow();
    expect(logger).not.toHaveBeenCalled();
    logger.mockRestore();
    delegate.findMany.mockResolvedValue([{ providerId: "gemini" }]);
    expect(await keys.configured(context)).toEqual({ gemini: true, xai: false });
    await keys.remove(context, "gemini");
    expect(delegate.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: context.workspaceId, providerId: "gemini" },
    });
  });
  it("rejects viewer/editor writes, absent context, invalid input and unconfigured encryption", async () => {
    const { keys, delegate } = setup();
    for (const role of ["EDITOR", "VIEWER"] as const)
      await expect(keys.write({ ...context, role }, "gemini", { key: "secret" })).rejects.toThrow(
        "Workspace owner",
      );
    await expect(keys.configured({ ...context, userId: "" })).rejects.toThrow();
    await expect(keys.write(context, "gemini", { key: "", extra: true })).rejects.toThrow(
      "required",
    );
    await expect(
      new ProviderKeys(
        { providerKey: delegate } as unknown as Database,
        new TokenVault(undefined),
      ).write(context, "gemini", { key }),
    ).rejects.toThrow();
    expect(delegate.upsert).not.toHaveBeenCalled();
    expect(() => parseVendor("openai")).toThrow();
    expect(parseVendor("xai")).toBe("xai");
    expect(await keys.resolve(context, "gemini")).toBeUndefined();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GEMINI_API_KEY", "environment-secret");
    expect(await keys.resolve(context, "gemini")).toBe("environment-secret");
    delegate.findUnique.mockResolvedValue({ keyVersion: "future" });
    await expect(keys.resolve(context, "gemini")).rejects.toThrow("version");
  });
  it("rejects malformed keys before encryption and storage", async () => {
    const { keys, delegate } = setup();
    await expect(keys.write(context, "gemini", { key: ` ${key}` })).rejects.toMatchObject({
      response: { code: "INVALID_KEY" },
    });
    await expect(keys.write(context, "xai", { key })).rejects.toMatchObject({
      response: { code: "INVALID_KEY" },
    });
    expect(delegate.upsert).not.toHaveBeenCalled();
  });
  it("authenticates every API action and makes health entirely offline", async () => {
    const { keys } = setup();
    const workspaces = { context: vi.fn().mockResolvedValue(context) };
    const controller = new ProvidersController(keys, workspaces as unknown as WorkspaceService);
    const request = { principal: { userId: "owner" } } as AuthenticatedRequest;
    for (const name of ["VIDEO", "IMAGE", "TEXT", "TTS", "MUSIC"])
      vi.stubEnv(`GEMINI_${name}_MODEL`, name.toLowerCase());
    vi.stubEnv("XAI_VIDEO_MODEL", "fallback");
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live forbidden"));
    expect(await controller.write(request, context.workspaceId, "gemini", { key })).toEqual({
      configured: true,
    });
    await controller.remove(request, context.workspaceId, "gemini");
    const health = await controller.health(request, context.workspaceId);
    expect(health).toHaveLength(6);
    expect(JSON.stringify(health)).not.toContain("secret");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
    workspaces.context.mockRejectedValue(new Error("Cross-workspace access denied"));
    await expect(controller.health(request, "other")).rejects.toThrow("Cross-workspace");
  });
});
