import { describe, expect, it, vi } from "vitest";
import {
  planningFixture,
  shotsFixture,
  scriptFixture,
  context,
} from "../script/planning.fixture.js";
import { wordCaptions } from "../composition/media-alignment.js";
import type { Run } from "../runs/runs.types.js";
import type { MediaAssembly } from "../composition/media-assembly.js";
import type { MediaJobs } from "../scene-media/media-jobs.js";
import type { MediaPlanning } from "../scene-media/media-planning.js";
import type { MediaProbe } from "./media-probe.js";
import { CriticEvidence } from "./critic-evidence.js";

describe("V5 evidence for V6", () => {
  it.each([true, false])(
    "loads V5 evidence with separate rendered captions %s",
    async (withCaptions) => {
      const request = planningFixture();
      const run = { id: request.runId, workspaceId: context.workspaceId } as Run;
      const shots = shotsFixture(request);
      const words = [{ text: "Hello", start: 0.1, end: 0.9 }];
      const checksum = "a".repeat(64);
      const receipts = shots.map((shot) => ({
        key: `shot-${shot.ordinal}`,
        providerId: "fixture",
        providerJobId: "job",
        modelId: "model",
        promptVersion: "v1",
        seconds: shot.durationSeconds,
        costMinor: 1,
        objectKey: `runs/permanent/${checksum}`,
        checksumSha256: checksum,
        mimeType: "video/mp4",
      }));
      const manifest = {
        schemaVersion: "1.0",
        workspaceId: context.workspaceId,
        runId: run.id,
        briefId: request.brief.id,
        briefVersion: request.brief.version,
        durationSeconds: 45,
        width: 1080,
        height: 1920,
        fps: 24,
        videoCodec: "h264",
        narrationLanguage: "English",
        receipts,
        words,
        promptVersions: [{}],
        totalCostMinor: 10,
        videoChecksumSha256: checksum,
      };
      const artifacts = [
        { kind: "final", contentType: "video/mp4", objectKey: "final", checksumSha256: checksum },
        { kind: "manifest", objectKey: "manifest" },
        { kind: "captions", contentType: "application/json", objectKey: "words" },
        { kind: "captions", contentType: "text/plain", objectKey: "ass" },
      ];
      const payloads: Record<string, Buffer> = {
        final: Buffer.from("final"),
        manifest: Buffer.from(JSON.stringify(manifest)),
        words: Buffer.from(JSON.stringify(words)),
        ass: Buffer.from(wordCaptions(words)),
        [`runs/permanent/${checksum}`]: Buffer.from("clip"),
      };
      const bytes = vi.fn(
        async (_context: unknown, item: { objectKey: string }) => payloads[item.objectKey]!,
      );
      const inspect = vi.fn(async () => ({
        durationSeconds: 6,
        width: 720,
        height: 1280,
        hasBlackFrames: false,
        hasFrozenFrames: false,
        captionDriftMs: 0,
      }));
      const service = new CriticEvidence(
        {
          artifacts: async () =>
            artifacts.filter((item) => withCaptions || item.objectKey !== "ass"),
        } as unknown as MediaAssembly,
        { bytes } as unknown as MediaJobs,
        {
          saved: async () => ({ script: scriptFixture(), manifest: { shots } }),
        } as unknown as MediaPlanning,
        { inspect } as unknown as MediaProbe,
      );
      const result = await service.load(context, run, request.brief);
      expect(result.final.toString()).toBe("final");
      expect(result.clips).toHaveLength(shots.length);
      expect(inspect).toHaveBeenCalledTimes(shots.length);
      expect(inspect).toHaveBeenCalledWith(Buffer.from("clip"), withCaptions ? 0 : null);
      expect(bytes).toHaveBeenCalledWith(context, expect.objectContaining({ objectKey: "final" }));
    },
  );
  it("fails closed when V5 evidence is absent", async () => {
    const request = planningFixture();
    const service = new CriticEvidence(
      { artifacts: async () => [] } as unknown as MediaAssembly,
      {} as MediaJobs,
      { saved: async () => null } as unknown as MediaPlanning,
      {} as MediaProbe,
    );
    await expect(
      service.load(context, { id: request.runId } as Run, request.brief),
    ).rejects.toThrow("evidence is incomplete");
  });
});
