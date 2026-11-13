import { describe, expect, it } from "vitest";
import { makeRenderInput } from "./composition";
import { assetId, pinnedRevision, production } from "./verification/fixtures";
const complete = {
  ...production,
  status: "SUCCEEDED" as const,
  scenes: production.scenes.map((scene) => ({
    ...scene,
    status: "SUCCEEDED" as const,
    outputs: [
      {
        kind: "IMAGE" as const,
        status: "SUCCEEDED" as const,
        assetId,
        assetVersion: 1,
        mediaType: "image/png",
        byteSize: 68,
        errorCode: null,
        errorMessage: null,
      },
    ],
  })),
};
describe("render input", () => {
  it("pins ordered production assets and durations to the exact script revision", () => {
    const input = makeRenderInput(complete, pinnedRevision, "12345678");
    expect(input.sourceMediaPackage.scriptRevision).toBe(1);
    expect(input.scenes.map((scene) => [scene.sceneId, scene.durationMs, scene.assetId])).toEqual([
      ["scene-one", 8000, assetId],
      ["scene-two", 12000, assetId],
    ]);
    expect(input.coverFrames).toEqual([{ assetId, assetVersion: 1, timestampMs: 0 }]);
  });
  it("accepts manually ASSIGNED visuals in the pinned package", () => {
    const assigned = {
      ...complete,
      scenes: complete.scenes.map((scene) => ({
        ...scene,
        outputs: scene.outputs.map((output) => ({ ...output, status: "ASSIGNED" as const })),
      })),
    };
    expect(makeRenderInput(assigned, pinnedRevision, "assigned-key").scenes[0]?.assetId).toBe(
      assetId,
    );
  });
  it("rejects incomplete packages and mismatched pinned revisions", () => {
    expect(() => makeRenderInput(production, pinnedRevision, "12345678")).toThrow();
    expect(() =>
      makeRenderInput(complete, { ...pinnedRevision, revision: 2 }, "12345678"),
    ).toThrow();
    expect(() =>
      makeRenderInput(
        { ...complete, scenes: complete.scenes.slice(0, 1) },
        pinnedRevision,
        "12345678",
      ),
    ).toThrow();
  });
});
