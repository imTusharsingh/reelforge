import { describe, expect, it } from "vitest";
import type { VideoReceipt } from "../orchestration/video-run.handlers.js";
import { mergeVideoEvidence } from "./video-job-evidence.js";

const clip = {
  objectKey: "clip",
  checksumSha256: "checksum",
  byteSize: 17,
  mimeType: "video/mp4",
  durationSeconds: 5,
  width: 720,
  height: 1280,
  fps: 24,
  billedSeconds: null,
};
const receipt = (
  costBasis: VideoReceipt["costBasis"],
  costMinor: number,
  seconds: number,
  media: VideoReceipt["media"],
): VideoReceipt => ({
  costBasis,
  costMinor,
  seconds,
  media,
  providerDurationSeconds: media?.durationSeconds ?? null,
  modelId: "fixture",
  promptVersion: "fixture",
});
const unbilled = receipt("RESERVATION", 31, 5, clip);
const deliveredBill = receipt("BILLED", 5, 5, clip);
const refusalBill = receipt("BILLED", 23, 23, null);
const duplicate = receipt("BILLED", 23, 24, null);

const cases = [
  { name: "unbilled refusal", receipt: null, terminal: "refused" as const },
  { name: "billed refusal", receipt: refusalBill, terminal: "refused" as const },
  { name: "unbilled success", receipt: unbilled },
  { name: "billed success", receipt: deliveredBill },
  { name: "equal bill, different seconds", receipt: duplicate },
];

describe("video evidence merge", () => {
  it.each(cases.flatMap((first) => cases.map((second) => ({ first, second }))))(
    "$first.name then $second.name",
    ({ first, second }) => {
      const merged = mergeVideoEvidence(first, second);
      const reports = [first.receipt, second.receipt];
      const billed = reports.filter((r) => r?.costBasis === "BILLED");
      const maximum = Math.max(...billed.map((r) => r!.costMinor));
      const winner = billed.find((r) => r!.costMinor === maximum) ?? reports.find(Boolean);
      const delivered = reports.some((r) => !!r?.media);
      expect(merged.delivered).toBe(delivered);
      expect(merged.terminal).toBe(delivered ? undefined : (first.terminal ?? second.terminal));
      expect(merged.receipt).toEqual(
        winner
          ? {
              ...winner,
              media: delivered ? clip : null,
              providerDurationSeconds: delivered ? 5 : null,
            }
          : null,
      );
    },
  );
});
