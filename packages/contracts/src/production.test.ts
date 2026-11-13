import { describe, expect, it } from "vitest";
import {
  AssignSceneAssetRequestSchema,
  RenderJobListQuerySchema,
  SceneMediaCapabilityCatalogSchema,
  SceneMediaJobListQuerySchema,
  SceneMediaJobMutationRequestSchema,
  ReplaceSceneMediaOutputRequestSchema,
} from "./production.js";

const workspaceId = "8b3f3f8e-3c9a-4b38-9d5e-6f7a8b9c0d1e";
const scriptId = "1b3f3f8e-3c9a-4b38-9d5e-6f7a8b9c0d1e";

describe("production contracts", () => {
  it("bounds discovery pagination and filters", () => {
    expect(SceneMediaJobListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 25 });
    expect(
      SceneMediaJobListQuerySchema.parse({
        scriptId,
        page: "2",
        pageSize: "100",
      }),
    ).toEqual({ scriptId, page: 2, pageSize: 100 });
    expect(SceneMediaJobListQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(SceneMediaJobListQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(SceneMediaJobListQuerySchema.safeParse({ unknown: "x" }).success).toBe(false);
    expect(RenderJobListQuerySchema.parse({ status: "SUCCEEDED" })).toEqual({
      status: "SUCCEEDED",
      page: 1,
      pageSize: 25,
    });
  });

  it("requires observed versions and a stable idempotency key for mutations", () => {
    expect(
      SceneMediaJobMutationRequestSchema.safeParse({
        idempotencyKey: "mutation-1",
        expectedJobVersion: 3,
      }).success,
    ).toBe(true);
    expect(
      SceneMediaJobMutationRequestSchema.safeParse({ idempotencyKey: "mutation-1" }).success,
    ).toBe(false);
    expect(
      ReplaceSceneMediaOutputRequestSchema.safeParse({
        idempotencyKey: "mutation-1",
        expectedJobVersion: 3,
        kind: "VIDEO",
      }).success,
    ).toBe(true);
    expect(
      ReplaceSceneMediaOutputRequestSchema.safeParse({
        idempotencyKey: "mutation-1",
        expectedJobVersion: 3,
        kind: "UNKNOWN",
      }).success,
    ).toBe(false);
    expect(
      AssignSceneAssetRequestSchema.safeParse({
        idempotencyKey: "mutation-1",
        expectedJobVersion: 3,
        kind: "IMAGE",
        assetId: scriptId,
        assetVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      AssignSceneAssetRequestSchema.safeParse({
        idempotencyKey: "mutation-1",
        expectedJobVersion: 3,
        kind: "IMAGE",
        assetId: scriptId,
        assetVersion: 1,
        extra: "nope",
      }).success,
    ).toBe(false);
    expect(
      AssignSceneAssetRequestSchema.safeParse({
        idempotencyKey: "mutation-1",
        expectedJobVersion: 3,
        kind: "IMAGE",
        assetId: "not-a-uuid",
        assetVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("validates a capability catalog without provider secrets", () => {
    const parsed = SceneMediaCapabilityCatalogSchema.parse({
      workspaceId,
      generatedAt: "2026-11-12T00:00:00.000Z",
      environment: "development",
      capabilities: [
        {
          kind: "IMAGE",
          available: false,
          reason: "PROVIDER_NOT_CONFIGURED",
          message: "No configured image provider is available.",
          providerId: null,
          capabilityId: null,
        },
      ],
    });
    expect(parsed.capabilities[0]?.available).toBe(false);
    expect(
      SceneMediaCapabilityCatalogSchema.safeParse({
        workspaceId,
        generatedAt: "2026-11-12T00:00:00.000Z",
        environment: "development",
        capabilities: [],
        secret: "must not be accepted",
      }).success,
    ).toBe(false);
  });
});
