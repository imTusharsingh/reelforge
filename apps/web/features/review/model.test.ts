import { describe, expect, it } from "vitest";
import {
  criteria,
  gateIds,
  gatesPass,
  needsOverride,
  parseQueue,
  parseRun,
  parseStatus,
  readiness,
  regenerationHref,
  renderContext,
  statuses,
  validateDecision,
} from "./model";
import { render, review, scorecard, workspaceId } from "./verification/fixtures";
describe("M26 persisted quality contracts", () => {
  it.each(statuses)("parses persisted status %s", (status) => {
    expect(parseRun({ ...review, status }, workspaceId).status).toBe(status);
  });
  it("validates workspace, identity, pending queue bounds and no foreign data", () => {
    expect(parseQueue([review], workspaceId)).toEqual([review]);
    expect(() => parseQueue([{ ...review, workspaceId: "foreign" }], workspaceId)).toThrow();
    expect(() => parseRun(review, workspaceId, "wrong-id")).toThrow();
    expect(() => parseQueue([{ ...review, status: "APPROVED" }], workspaceId)).toThrow();
    expect(() => parseQueue([review, review], workspaceId)).toThrow();
    expect(() => parseQueue(Array(51).fill(review), workspaceId)).toThrow();
    expect(() => parseRun({ ...review, status: "UNRECOGNIZED" }, workspaceId)).toThrow();
  });
  it("distinguishes missing, failed and passing hard-gate evidence", () => {
    expect(gatesPass(review.gateSummary)).toBe(true);
    expect(gatesPass([])).toBe(false);
    expect(gatesPass(review.gateSummary.map((g) => ({ ...g, evidence: [] })))).toBe(false);
    expect(gatesPass(review.gateSummary.map((g) => ({ ...g, passed: false })))).toBe(false);
    expect(() =>
      parseRun(
        { ...review, gateSummary: [{ id: "AUDIO", passed: "true", evidence: [] }] },
        workspaceId,
      ),
    ).toThrow();
    expect(() =>
      parseRun(
        { ...review, gateSummary: [review.gateSummary[0], review.gateSummary[0]] },
        workspaceId,
      ),
    ).toThrow();
  });
  it("accepts only a complete persisted scorecard and provenance", () => {
    expect(parseRun(review, workspaceId).scorecard).toBeNull();
    expect(parseRun({ ...review, scorecard }, workspaceId).scorecard).toEqual(scorecard);
    for (const id of criteria)
      expect(() =>
        parseRun(
          {
            ...review,
            scorecard: { ...scorecard, criteria: { ...scorecard.criteria, [id]: { score: 101 } } },
          },
          workspaceId,
        ),
      ).toThrow();
    expect(() =>
      parseRun({ ...review, scorecard: { ...scorecard, metadata: {} } }, workspaceId),
    ).toThrow();
  });
  it("rejects scorecards outside the persisted M11 evidence/provenance bounds", () => {
    for (const invalid of [
      { ...scorecard, metadata: { ...scorecard.metadata, modelVersion: "m".repeat(201) } },
      { ...scorecard, metadata: { ...scorecard.metadata, extra: "unsupported" } },
      {
        ...scorecard,
        criteria: {
          ...scorecard.criteria,
          FACTUALITY: { score: 84, evidence: Array(21).fill("Evidence"), limitations: [] },
        },
      },
      {
        ...scorecard,
        criteria: {
          ...scorecard.criteria,
          FACTUALITY: { score: 84, evidence: ["e".repeat(1001)], limitations: [] },
        },
      },
    ])
      expect(() => parseRun({ ...review, scorecard: invalid }, workspaceId)).toThrow();
  });
  it.each(["OWNER", "EDITOR"])("allows validated %s approval and rejection", (role) => {
    for (const action of ["APPROVE", "REJECT"] as const)
      expect(() =>
        validateDecision(review, { action, reason: "Reviewed the evidence" }, role, []),
      ).not.toThrow();
  });
  it("blocks Viewer, blank reasons, closed and superseded reviews and failed gate approvals", () => {
    const d = { action: "APPROVE" as const, reason: "Reviewed" };
    expect(() => validateDecision(review, d, "VIEWER", [])).toThrow();
    expect(() => validateDecision(review, { ...d, reason: " " }, "OWNER", [])).toThrow();
    for (const status of [
      "APPROVED",
      "REJECTED",
      "CHANGES_REQUESTED",
      "SUPERSEDED",
      "AUTO_APPROVED",
    ] as const)
      expect(() => validateDecision({ ...review, status }, d, "OWNER", [])).toThrow();
    expect(() =>
      validateDecision({ ...review, supersededAt: review.createdAt }, d, "OWNER", []),
    ).toThrow();
    expect(() => validateDecision({ ...review, gateSummary: [] }, d, "OWNER", [])).toThrow();
    expect(() => validateDecision({ ...review, status: "BLOCKED" }, d, "OWNER", [])).toThrow();
  });
  it("requires explicit target, pinned scene, and failed-gate override where needed", () => {
    const d = { action: "REQUEST_CHANGES" as const, reason: "Improve pacing" };
    expect(() => validateDecision(review, d, "EDITOR", [])).toThrow();
    expect(() =>
      validateDecision(
        review,
        { ...d, regeneration: { stage: "SCENE", sceneId: "foreign" } },
        "EDITOR",
        ["existing"],
      ),
    ).toThrow();
    expect(() =>
      validateDecision(
        review,
        { ...d, regeneration: { stage: "SCENE", sceneId: "existing" } },
        "EDITOR",
        ["existing"],
      ),
    ).not.toThrow();
    const blocked = {
      ...review,
      gateSummary: review.gateSummary.map((g) => ({ ...g, passed: g.id !== "DURATION" })),
    };
    expect(needsOverride(blocked, "RENDER")).toBe(false);
    expect(() =>
      validateDecision(blocked, { ...d, regeneration: { stage: "SCRIPT" } }, "OWNER", []),
    ).toThrow();
    expect(() =>
      validateDecision(
        blocked,
        { ...d, regeneration: { stage: "SCRIPT" }, overrideReason: "Rework timing at the source" },
        "OWNER",
        [],
      ),
    ).not.toThrow();
    expect(() =>
      validateDecision(
        review,
        { action: "REJECT", reason: "No", overrideReason: "Unsupported" },
        "OWNER",
        [],
      ),
    ).toThrow();
  });
  it.each(statuses)("readiness for %s uses current state and all gate evidence", (status) => {
    expect(
      readiness({ renderJobId: render.id, status, gateSummary: review.gateSummary }).eligible,
    ).toBe(["APPROVED", "AUTO_APPROVED"].includes(status));
    expect(readiness({ renderJobId: render.id, status, gateSummary: [] }).eligible).toBe(false);
  });
  it("validates render status identity and explains missing current evidence", () => {
    expect(() =>
      parseStatus(
        { renderJobId: "foreign", status: null, gateSummary: null },
        workspaceId,
        render.id,
      ),
    ).toThrow();
    expect(
      readiness({ renderJobId: render.id, status: null, gateSummary: null }).blockers,
    ).toHaveLength(gateIds.length + 1);
  });
  it("routes safely to existing workflows without dispatching work", () => {
    expect(regenerationHref("SCENE", render)).toContain("/production/jobs/");
    expect(regenerationHref("SCRIPT", render)).toContain("/planning/scripts/");
    expect(regenerationHref("RENDER", render)).toBe(`/production/renders/${render.id}`);
    expect(renderContext(render).sceneIds).toContain("scene-one");
    expect(regenerationHref("SCRIPT", { ...render, input: {} })).toBeNull();
  });
  it("links render regeneration by persisted render ID without script context", () => {
    expect(regenerationHref("RENDER", { ...render, input: {}, id: "render/id?" })).toBe(
      "/production/renders/render%2Fid%3F",
    );
  });
});
