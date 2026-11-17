import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isCompletePackage,
  parseAssignAssetInput,
  parseSceneMediaJobListQuery,
  providerEnvironment,
} from "./scene-media.validation.js";
import type { SceneMediaPackage } from "./scene-media.types.js";
describe("retained historic package boundary", () => {
  it("validates pagination and immutable assignment pins", () => {
    expect(parseSceneMediaJobListQuery({})).toMatchObject({ page: 1, pageSize: 25 });
    expect(() => parseSceneMediaJobListQuery({ page: "-1" })).toThrow();
    expect(() => parseAssignAssetInput({})).toThrow();
    expect(
      parseAssignAssetInput({
        idempotencyKey: "assignment",
        expectedJobVersion: 1,
        assetId: randomUUID(),
        assetVersion: 2,
        kind: "VIDEO",
      }),
    ).toMatchObject({ kind: "VIDEO", assetVersion: 2 });
  });
  it("derives only environment metadata, with no live health probe", () => {
    for (const value of ["production", "staging", "test"] as const)
      expect(providerEnvironment({ NODE_ENV: value })).toBe(value);
    expect(providerEnvironment({ NODE_ENV: "development" })).toBe("development");
    expect(providerEnvironment({})).toBe("development");
  });
  it("does not export missing media and retains assigned legacy assets", () => {
    const output = {
      status: "ASSIGNED",
      assetId: "asset",
      assetVersion: 1,
      byteSize: 10,
      checksumSha256: "a".repeat(64),
      mediaType: "video/mp4",
      providerAssetId: null,
    };
    const pkg = {
      schemaVersion: "1.0",
      status: "SUCCEEDED",
      scenes: [{ status: "SUCCEEDED", outputs: [output] }],
    } as unknown as SceneMediaPackage;
    expect(isCompletePackage(pkg)).toBe(true);
    for (const patch of [
      { assetId: null },
      { assetVersion: 0 },
      { byteSize: 0 },
      { checksumSha256: null },
      { mediaType: null },
      { status: "FAILED_RETRYABLE" },
      { status: "SUCCEEDED" },
    ])
      expect(
        isCompletePackage({
          ...pkg,
          scenes: [{ ...pkg.scenes[0]!, outputs: [{ ...pkg.scenes[0]!.outputs[0]!, ...patch }] }],
        } as SceneMediaPackage),
      ).toBe(false);
    expect(isCompletePackage({ ...pkg, scenes: [] })).toBe(false);
  });
});
