import { record, type RenderJob } from "../production/model";

export const statuses = [
  "BLOCKED",
  "AI_REVIEW_UNAVAILABLE",
  "REVIEW_REQUIRED",
  "AUTO_APPROVED",
  "APPROVED",
  "REJECTED",
  "CHANGES_REQUESTED",
  "SUPERSEDED",
] as const;
export type Status = (typeof statuses)[number];
export const gateIds = [
  "ARTIFACT_INTEGRITY",
  "ASPECT_RATIO",
  "DURATION",
  "VIDEO_CODEC",
  "AUDIO",
  "SUBTITLES",
  "SCRIPT_PROVENANCE",
  "GENRE_POLICY",
  "APPROVAL_POLICY",
  "ASSET_RIGHTS",
  "DISCLOSURES",
] as const;
export type Gate = { id: (typeof gateIds)[number]; passed: boolean; evidence: string[] };
export const criteria = ["FACTUALITY", "CLARITY", "COHERENCE", "ENGAGEMENT", "GENRE_FIT"] as const;
export type Scorecard = {
  score: number;
  criteria: Record<
    (typeof criteria)[number],
    { score: number; evidence: string[]; limitations: string[] }
  >;
  metadata: {
    modelVersion: string;
    promptVersion: string;
    cost: number | null;
    currency?: string;
    usage?: Partial<Record<"inputTokens" | "outputTokens" | "seconds" | "characters", number>>;
  };
};
export type Action = "APPROVE" | "REJECT" | "REQUEST_CHANGES";
export type Stage = "SCENE" | "SCRIPT" | "RENDER";
export type Run = {
  id: string;
  renderJobId: string;
  status: Status;
  gateSummary: Gate[];
  scorecard: Scorecard | null;
  policySnapshot: {
    mode: "MANUAL" | "AUTO";
    scoreThreshold: number;
    criterionThresholds: Partial<Record<(typeof criteria)[number], number>>;
  };
  disclosures: string[];
  limitations: string[];
  decisions: {
    id: string;
    action: Action;
    reason: string;
    overrideReason: string | null;
    actorUserId: string;
    createdAt: string;
  }[];
  regenerationRequests: {
    id: string;
    stage: Stage;
    sceneId: string | null;
    attempt: number;
    createdAt: string;
  }[];
  createdAt: string;
  supersededAt: string | null;
};
export type RenderStatus = {
  renderJobId: string;
  status: Status | null;
  gateSummary: Gate[] | null;
};
export type Decision = {
  action: Action;
  reason: string;
  overrideReason?: string;
  regeneration?: { stage: Stage; sceneId?: string };
};
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const date = (v: unknown): boolean => text(v) && Number.isFinite(Date.parse(v));
const score = (v: unknown): boolean => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 100;
const member = (v: unknown, values: readonly string[]): boolean =>
  typeof v === "string" && values.includes(v);
const action = (v: unknown): boolean => member(v, ["APPROVE", "REJECT", "REQUEST_CHANGES"]);
const stage = (v: unknown): boolean => member(v, ["SCENE", "SCRIPT", "RENDER"]);
function invalid(): never {
  throw new Error("The quality service returned invalid or mismatched data.");
}
function scope(v: Record<string, unknown>, workspaceId: string): void {
  if ("workspaceId" in v && v.workspaceId !== workspaceId) invalid();
}
export function parseGates(v: unknown): Gate[] {
  if (
    !Array.isArray(v) ||
    !v.every(
      (g) =>
        record(g) && member(g.id, gateIds) && typeof g.passed === "boolean" && strings(g.evidence),
    )
  )
    invalid();
  if (new Set(v.map((g) => (g as Gate).id)).size !== v.length) invalid();
  return v as Gate[];
}
function parseScorecard(v: unknown): Scorecard | null {
  if (v === null) return null;
  if (!record(v) || !score(v.score) || !record(v.criteria) || !record(v.metadata)) invalid();
  for (const id of criteria) {
    const c = v.criteria[id];
    if (
      !record(c) ||
      !score(c.score) ||
      !strings(c.evidence) ||
      c.evidence.length === 0 ||
      !strings(c.limitations)
    )
      invalid();
  }
  const m = v.metadata;
  if (
    !text(m.modelVersion) ||
    !text(m.promptVersion) ||
    !(m.cost === null || (typeof m.cost === "number" && Number.isFinite(m.cost) && m.cost >= 0)) ||
    (m.currency !== undefined && !text(m.currency))
  )
    invalid();
  if (
    m.usage !== undefined &&
    (!record(m.usage) ||
      !Object.entries(m.usage).every(
        ([k, n]) =>
          ["inputTokens", "outputTokens", "seconds", "characters"].includes(k) &&
          typeof n === "number" &&
          Number.isFinite(n) &&
          n >= 0 &&
          (k === "seconds" || Number.isInteger(n)),
      ))
  )
    invalid();
  return v as Scorecard;
}
export function parseRun(v: unknown, workspaceId: string, runId?: string): Run {
  if (!record(v)) invalid();
  scope(v, workspaceId);
  const p = v.policySnapshot;
  if (
    !text(v.id) ||
    (runId !== undefined && v.id !== runId) ||
    !text(v.renderJobId) ||
    !member(v.status, statuses) ||
    !record(p) ||
    !member(p.mode, ["MANUAL", "AUTO"]) ||
    !score(p.scoreThreshold) ||
    !record(p.criterionThresholds) ||
    !Object.entries(p.criterionThresholds).every(([k, n]) => member(k, criteria) && score(n)) ||
    !strings(v.disclosures) ||
    !strings(v.limitations) ||
    !date(v.createdAt) ||
    !(v.supersededAt === null || date(v.supersededAt))
  )
    invalid();
  if (
    !Array.isArray(v.decisions) ||
    !v.decisions.every(
      (d) =>
        record(d) &&
        text(d.id) &&
        action(d.action) &&
        text(d.reason) &&
        (d.overrideReason === null || text(d.overrideReason)) &&
        text(d.actorUserId) &&
        date(d.createdAt),
    )
  )
    invalid();
  if (
    !Array.isArray(v.regenerationRequests) ||
    !v.regenerationRequests.every(
      (r) =>
        record(r) &&
        text(r.id) &&
        stage(r.stage) &&
        (r.stage === "SCENE" ? text(r.sceneId) : r.sceneId === null) &&
        Number.isInteger(r.attempt) &&
        Number(r.attempt) >= 1 &&
        date(r.createdAt),
    )
  )
    invalid();
  return {
    ...v,
    gateSummary: parseGates(v.gateSummary),
    scorecard: parseScorecard(v.scorecard),
  } as Run;
}
export function parseQueue(v: unknown, workspaceId: string): Run[] {
  if (!Array.isArray(v) || v.length > 50) invalid();
  const runs = v.map((r) => parseRun(r, workspaceId));
  if (new Set(runs.map((r) => r.id)).size !== runs.length || runs.some((r) => !pending(r)))
    invalid();
  return runs;
}
export function parseStatus(v: unknown, workspaceId: string, renderJobId: string): RenderStatus {
  if (!record(v)) invalid();
  scope(v, workspaceId);
  if (v.renderJobId !== renderJobId || !(v.status === null || member(v.status, statuses)))
    invalid();
  return {
    renderJobId,
    status: v.status as Status | null,
    gateSummary: v.gateSummary === null ? null : parseGates(v.gateSummary),
  };
}
export const label = (v: string): string => v.toLowerCase().replaceAll("_", " ");
export const pending = (r: Run): boolean =>
  r.supersededAt === null &&
  ["REVIEW_REQUIRED", "BLOCKED", "AI_REVIEW_UNAVAILABLE"].includes(r.status);
export const gatesPass = (g: Gate[] | null): boolean =>
  g !== null &&
  gateIds.every((id) =>
    g.some((gate) => gate.id === id && gate.passed && gate.evidence.length > 0),
  );
export function readiness(s: RenderStatus): { eligible: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!s.status || !["APPROVED", "AUTO_APPROVED"].includes(s.status))
    blockers.push(s.status ? `Current review: ${label(s.status)}.` : "No current quality review.");
  for (const id of gateIds) {
    const g = s.gateSummary?.find((g) => g.id === id);
    if (!g || !g.evidence.length) blockers.push(`${label(id)}: evidence unavailable.`);
    else if (!g.passed) blockers.push(`${label(id)}: failed.`);
  }
  return { eligible: blockers.length === 0, blockers };
}
export function renderContext(render: RenderJob): { sceneIds: string[]; scriptId: string | null } {
  const input = render.input;
  const sceneIds =
    Array.isArray(input.scenes) && input.scenes.every((s) => record(s) && text(s.sceneId))
      ? input.scenes.map((s) => String((s as Record<string, unknown>).sceneId))
      : [];
  return {
    sceneIds,
    scriptId:
      record(input.sourceMediaPackage) && text(input.sourceMediaPackage.scriptId)
        ? input.sourceMediaPackage.scriptId
        : null,
  };
}
// Conservative guidance: rights routes depend on backend asset-pair evidence. The
// explicit override remains mandatory here when a matching route cannot be proven.
export function needsOverride(run: Run, target: Stage): boolean {
  const failed = run.gateSummary.filter((g) => !g.passed).map((g) => g.id);
  if (!failed.length) return false;
  if (target === "RENDER" && failed.some((id) => gateIds.slice(0, 6).includes(id))) return false;
  if (
    target === "SCRIPT" &&
    failed.some((id) => id === "SCRIPT_PROVENANCE" || id === "GENRE_POLICY")
  )
    return false;
  return true;
}
export function validateDecision(
  run: Run,
  decision: Decision,
  role: string,
  sceneIds: string[],
): void {
  if (!["OWNER", "EDITOR"].includes(role)) throw new Error("Owner or Editor permission required.");
  if (!pending(run)) throw new Error("Only a current pending review can receive a decision.");
  if (!action(decision.action) || !decision.reason.trim() || decision.reason.trim().length > 4000)
    throw new Error("Enter an explicit reason (up to 4000 characters).");
  if (decision.action === "APPROVE" && (run.status === "BLOCKED" || !gatesPass(run.gateSummary)))
    throw new Error("Approval requires every hard gate with evidence to pass.");
  if (decision.action !== "REQUEST_CHANGES") {
    if (decision.regeneration || decision.overrideReason)
      throw new Error("Regeneration applies only to change requests.");
    return;
  }
  const target = decision.regeneration;
  if (!target || !stage(target.stage)) throw new Error("Select a regeneration target.");
  if (target.stage === "SCENE" && (!target.sceneId || !sceneIds.includes(target.sceneId)))
    throw new Error("Select an existing scene from this pinned render.");
  if (target.stage !== "SCENE" && target.sceneId !== undefined)
    throw new Error("Only scene regeneration accepts a scene ID.");
  if (
    (needsOverride(run, target.stage) && !decision.overrideReason?.trim()) ||
    (decision.overrideReason !== undefined &&
      (!decision.overrideReason.trim() || decision.overrideReason.trim().length > 1000))
  )
    throw new Error("Enter an override reason (up to 1000 characters) for this failed-gate route.");
}
export function regenerationHref(stage: Stage, render: RenderJob): string | null {
  const context = renderContext(render);
  if (stage === "SCENE") return `/production/jobs/${encodeURIComponent(render.sceneMediaJobId)}`;
  if (!context.scriptId) return null;
  return stage === "SCRIPT"
    ? `/planning/scripts/${encodeURIComponent(context.scriptId)}`
    : `/production/scripts/${encodeURIComponent(context.scriptId)}`;
}
