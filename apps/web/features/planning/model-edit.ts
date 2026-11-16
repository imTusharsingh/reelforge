import type { WorkspaceRole } from "../../lib/api";
import type { Idea, IdeaDraft, Scene, ScriptDocument, IdeaStatus } from "./model-types";
import { finite } from "./model-parse";
export function canWrite(role: WorkspaceRole): boolean {
  return role === "OWNER" || role === "EDITOR";
}
export function nextStatus(status: IdeaStatus): IdeaStatus[] {
  switch (status) {
    case "DRAFT":
      return ["BACKLOG", "APPROVED", "REJECTED"];
    case "BACKLOG":
      return ["APPROVED", "REJECTED"];
    case "APPROVED":
      return ["SCHEDULED", "REJECTED"];
    case "SCHEDULED":
      return ["REJECTED"];
    case "REJECTED":
      return ["BACKLOG"];
  }
}
export function normalizeSceneTimings(scenes: Scene[]): Scene[] {
  let start = 0;
  return scenes.map((scene) => {
    const result = { ...scene, startSeconds: start };
    start += scene.durationSeconds;
    return result;
  });
}
export function validateDocument(document: ScriptDocument): string | null {
  if (
    !document.title.trim() ||
    !document.hook.trim() ||
    !document.cta.trim() ||
    !document.metadata.genre.trim()
  )
    return "Complete the script title, hook, CTA and genre.";
  if (!document.scenes.length) return "A script requires at least one scene.";
  if (new Set(document.scenes.map((s) => s.id)).size !== document.scenes.length)
    return "Scene identifiers must be unique.";
  if (
    document.scenes.some(
      (s) =>
        !s.visualDescription.trim() ||
        !s.camera.trim() ||
        !finite(s.durationSeconds) ||
        s.durationSeconds <= 0,
    )
  )
    return "Every scene needs visuals, camera direction and a positive duration.";
  if (document.scenes.some((s) => !finite(s.startSeconds) || s.startSeconds < 0))
    return "Scene start times must be non-negative.";
  if (
    !finite(document.metadata.targetDurationSeconds) ||
    document.metadata.targetDurationSeconds <= 0
  )
    return "Target duration must be a positive finite number.";
  if (
    document.claims?.some((c) => {
      try {
        return !c.text.trim() || !["https:", "http:"].includes(new URL(c.sourceUrl).protocol);
      } catch {
        return true;
      }
    })
  )
    return "Claims need text and a valid HTTP or HTTPS source URL.";
  let expectedStart = 0;
  for (const scene of document.scenes) {
    if (Math.abs(scene.startSeconds - expectedStart) > 0.000001)
      return "This storyboard uses sequential scenes without gaps or overlaps. Use Reflow scene starts to align the draft before saving.";
    expectedStart += scene.durationSeconds;
  }
  const refs = document.scenes.flatMap((s) => s.characterRefs.map((r) => r.versionId));
  if (new Set(refs).size !== refs.length)
    return "The current service accepts a character version only once per script. Remove repeated assignments before saving.";
  const duration = document.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  if (Math.abs(duration - document.metadata.targetDurationSeconds) > 1)
    return "Scene duration and target duration must match within one second.";
  return null;
}
export function ideaPayload(draft: IdeaDraft): Record<string, unknown> {
  for (const field of ["title", "topic", "hook", "angle", "audience", "expectedFormat"] as const)
    if (!draft[field].trim()) throw new Error(`Complete ${field}.`);
  if (!draft.channelId && !draft.seriesId) throw new Error("Select a channel or series.");
  return {
    title: draft.title.trim(),
    topic: draft.topic.trim(),
    hook: draft.hook.trim(),
    angle: draft.angle.trim(),
    audience: draft.audience.trim(),
    expectedFormat: draft.expectedFormat.trim(),
    references: draft.references.map((reference) => reference.trim()).filter(Boolean),
    sourceNotes: draft.sourceNotes,
    ...(draft.channelId ? { channelId: draft.channelId } : {}),
    ...(draft.seriesId ? { seriesId: draft.seriesId } : {}),
  };
}
export function draftFromIdea(idea: Idea): IdeaDraft {
  return {
    title: idea.title,
    topic: idea.topic,
    hook: idea.hook,
    angle: idea.angle,
    audience: idea.audience,
    expectedFormat: idea.expectedFormat,
    references: [...idea.references],
    sourceNotes: idea.sourceNotes ?? "",
    channelId: idea.channelId ?? "",
    seriesId: idea.seriesId ?? "",
  };
}
export function patchScene(
  document: ScriptDocument,
  id: string,
  patch: Partial<Scene>,
): ScriptDocument {
  return {
    ...document,
    scenes: document.scenes.map((scene) =>
      scene.id === id ? { ...scene, ...patch, id: scene.id } : scene,
    ),
  };
}
export function moveScene(document: ScriptDocument, id: string, offset: number): ScriptDocument {
  const scenes = [...document.scenes];
  const index = scenes.findIndex((s) => s.id === id);
  const destination = index + offset;
  if (index < 0 || destination < 0 || destination >= scenes.length) return document;
  [scenes[index], scenes[destination]] = [scenes[destination]!, scenes[index]!];
  return { ...document, scenes: normalizeSceneTimings(scenes) };
}
export function mergeRevision(
  base: ScriptDocument,
  local: ScriptDocument,
  remote: ScriptDocument,
): ScriptDocument {
  const result = structuredClone(remote);
  const b = base.scenes.map((s) => s.id).join();
  const l = local.scenes.map((s) => s.id).join();
  const r = remote.scenes.map((s) => s.id).join();
  if (l !== b && r !== b && l !== r)
    throw new Error("Both editors changed scene order. Compare manually.");
  const localChanged = new Map(
    local.scenes
      .filter((s) => JSON.stringify(s) !== JSON.stringify(base.scenes.find((v) => v.id === s.id)))
      .map((s) => [s.id, s]),
  );
  for (const [id, scene] of localChanged) {
    const prior = base.scenes.find((s) => s.id === id),
      server = remote.scenes.find((s) => s.id === id);
    if (
      JSON.stringify(server) !== JSON.stringify(prior) &&
      JSON.stringify(server) !== JSON.stringify(scene)
    )
      throw new Error(`Scene ${id} changed in both drafts. Compare manually.`);
  }
  if (l !== b && r === b)
    result.scenes = local.scenes.map(
      (s) => localChanged.get(s.id) ?? remote.scenes.find((v) => v.id === s.id) ?? s,
    );
  else result.scenes = remote.scenes.map((s) => localChanged.get(s.id) ?? s);
  for (const key of [
    "title",
    "hook",
    "dialogue",
    "narration",
    "cta",
    "metadata",
    "claims",
  ] as const) {
    if (JSON.stringify(local[key]) !== JSON.stringify(base[key])) {
      if (
        JSON.stringify(remote[key]) !== JSON.stringify(base[key]) &&
        JSON.stringify(remote[key]) !== JSON.stringify(local[key])
      )
        throw new Error(`${key} changed in both drafts.`);
      Object.assign(result, { [key]: local[key] });
    }
  }
  return result;
}
